import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rm, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import {
  type CreateMediaAssetInput,
  type ManjuDatabase,
  type MediaAssetRecord,
} from './database.js'
import type { JsonObject } from './types.js'

const DEFAULT_MAX_MEDIA_BYTES = 250 * 1024 * 1024

export class MediaStoreError extends Error {
  constructor(
    readonly code:
      | 'ASSET_NOT_FOUND'
      | 'ASSET_FILE_MISSING'
      | 'ASSET_EXISTS'
      | 'INVALID_MEDIA'
      | 'MEDIA_TOO_LARGE'
      | 'UNSAFE_MEDIA_PATH',
    message: string,
  ) {
    super(message)
    this.name = 'MediaStoreError'
  }
}

export interface SaveMediaInput {
  id?: string
  projectId: string
  episodeId?: string | null
  kind: string
  version?: number
  bytes: Uint8Array
  mimeType?: string
  source: string
  providerId?: string | null
  generationJobId?: string | null
  generationParameters?: JsonObject
  sourceRevisionId?: string | null
  parentAssetId?: string | null
  width?: number | null
  height?: number | null
  durationSeconds?: number | null
  status?: string
}

export interface OpenMediaResult {
  asset: MediaAssetRecord
  file: Awaited<ReturnType<typeof open>>
  size: number
  mimeType: string
}

export interface MediaStoreHealth {
  status: 'ok' | 'unavailable'
  safe: boolean
  writable: boolean
  message: string
}

export interface SaveMediaOptions {
  /**
   * Runs immediately before the asset row is inserted, in the same SQLite
   * transaction. This is used by local, non-provider operations that need to
   * create a durable Job before the new immutable Asset can reference it.
   */
  beforeCreate?: (database: ManjuDatabase) => void
  /**
   * Runs synchronously in the same SQLite transaction that creates the asset
   * index row. This is intended for relational links such as
   * dialogue_lines.speech_asset_id; throwing rolls back the asset row and the
   * already-published file is removed by save().
   */
  afterCreate?: (asset: MediaAssetRecord, database: ManjuDatabase) => void
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

export function imageDimensions(bytes: Uint8Array, mimeType: string): { width?: number; height?: number } {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    return {
      width: Buffer.from(bytes).readUInt32BE(16),
      height: Buffer.from(bytes).readUInt32BE(20),
    }
  }
  if (mimeType === 'image/gif' && bytes.length >= 10) {
    return {
      width: bytes[6] | (bytes[7] << 8),
      height: bytes[8] | (bytes[9] << 8),
    }
  }
  if (mimeType === 'image/webp' && bytes.length >= 30 && ascii(bytes, 12, 16) === 'VP8X') {
    return {
      width: readUint24LE(bytes, 24) + 1,
      height: readUint24LE(bytes, 27) + 1,
    }
  }
  if (mimeType === 'image/jpeg' && bytes.length >= 10) {
    const markers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1]
      if (markers.has(marker)) {
        return {
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        }
      }
      if (marker === 0xd9 || marker === 0xda) break
      const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3]
      if (segmentLength < 2) break
      offset += segmentLength + 2
    }
  }
  return {}
}

function normalizedAdvertisedMime(value: string | undefined): string | undefined {
  const normalized = value?.split(';', 1)[0].trim().toLowerCase()
  return normalized || undefined
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString('ascii')
}

export function detectMediaMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && ascii(bytes, 0, 6).startsWith('GIF8')) return 'image/gif'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'audio/wav'
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg'
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') return 'video/mp4'
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'video/webm'
  }
  throw new MediaStoreError('INVALID_MEDIA', '无法识别媒体文件格式')
}

function extensionForMime(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  }
  const extension = extensions[mimeType]
  if (!extension) throw new MediaStoreError('INVALID_MEDIA', '不支持的媒体文件格式')
  return extension
}

function stableDirectorySegment(projectId: string): string {
  const readable = projectId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'project'
  const suffix = createHash('sha256').update(projectId).digest('hex').slice(0, 10)
  return `${readable}-${suffix}`
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function validateStoredRelativePath(filePath: string): void {
  if (!filePath || filePath.includes('\0') || isAbsolute(filePath) || filePath.includes('\\')) {
    throw new MediaStoreError('UNSAFE_MEDIA_PATH', '资产文件路径无效')
  }
  const components = filePath.split('/')
  if (components.some((component) => !component || component === '.' || component === '..')) {
    throw new MediaStoreError('UNSAFE_MEDIA_PATH', '资产文件路径无效')
  }
}

function validateAssetId(id: string): void {
  // Asset IDs become file names, so only accept a single portable path
  // segment. In particular, never let a caller supplied `../...` ID reach
  // resolve(), even though later containment checks are kept as defence in
  // depth.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new MediaStoreError('UNSAFE_MEDIA_PATH', '资产 ID 不是安全的文件名')
  }
}

async function checkedDirectoryRealPath(path: string, parentRealPath?: string): Promise<string> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MediaStoreError('UNSAFE_MEDIA_PATH', '媒体存储目录不存在')
    }
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new MediaStoreError('UNSAFE_MEDIA_PATH', '媒体存储目录不能是符号链接')
  }
  const resolvedPath = await realpath(path)
  if (parentRealPath && !isWithin(parentRealPath, resolvedPath)) {
    throw new MediaStoreError('UNSAFE_MEDIA_PATH', '媒体存储目录指向运行目录之外')
  }
  return resolvedPath
}

export class MediaStore {
  readonly runtimeDirectory: string
  readonly mediaDirectory: string
  private readonly maxBytes: number

  constructor(
    private readonly database: ManjuDatabase,
    options: { runtimeDirectory: string; maxBytes?: number },
  ) {
    this.runtimeDirectory = resolve(options.runtimeDirectory)
    this.mediaDirectory = resolve(this.runtimeDirectory, 'media')
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new RangeError('maxBytes must be a positive integer')
    }
  }

  async init(): Promise<void> {
    await mkdir(this.mediaDirectory, { recursive: true })
    const runtimeRealPath = await realpath(this.runtimeDirectory)
    await checkedDirectoryRealPath(this.mediaDirectory, runtimeRealPath)
  }

  /**
   * Revalidates the media root instead of trusting the startup check. The
   * write probe is an exclusive, process-owned file which is synced and
   * removed before a healthy result is returned. No project media is opened,
   * changed, or enumerated by this check.
   */
  async health(): Promise<MediaStoreHealth> {
    let directoryIsSafe = false
    let probePath: string | undefined
    let probeHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const runtimeRealPath = await realpath(this.runtimeDirectory)
      const mediaRealPath = await checkedDirectoryRealPath(this.mediaDirectory, runtimeRealPath)
      directoryIsSafe = true
      probePath = resolve(mediaRealPath, `.manju-write-probe-${process.pid}-${randomUUID()}`)
      if (!isWithin(mediaRealPath, probePath)) {
        throw new MediaStoreError('UNSAFE_MEDIA_PATH', '媒体目录写入探针路径越界')
      }
      probeHandle = await open(probePath, 'wx', 0o600)
      await probeHandle.writeFile('ok')
      await probeHandle.sync()
      await probeHandle.close()
      probeHandle = undefined
      await unlink(probePath)
      probePath = undefined
      return {
        status: 'ok',
        safe: true,
        writable: true,
        message: '媒体目录安全且可写',
      }
    } catch (error) {
      await probeHandle?.close().catch(() => undefined)
      if (probePath) await unlink(probePath).catch(() => undefined)
      return {
        status: 'unavailable',
        safe: directoryIsSafe,
        writable: false,
        message: directoryIsSafe
          ? '媒体目录不可写或写入探针无法安全清理'
          : error instanceof MediaStoreError && error.code === 'UNSAFE_MEDIA_PATH'
            ? '媒体目录未通过安全检查'
            : '媒体目录不存在或无法访问',
      }
    }
  }

  async save(input: SaveMediaInput, options: SaveMediaOptions = {}): Promise<MediaAssetRecord> {
    if (input.bytes.byteLength === 0) throw new MediaStoreError('INVALID_MEDIA', '媒体文件为空')
    if (input.bytes.byteLength > this.maxBytes) {
      throw new MediaStoreError('MEDIA_TOO_LARGE', `媒体文件不能超过 ${this.maxBytes} 字节`)
    }
    const detectedMime = detectMediaMime(input.bytes)
    const advertisedMime = normalizedAdvertisedMime(input.mimeType)
    if (advertisedMime && advertisedMime !== detectedMime) {
      throw new MediaStoreError('INVALID_MEDIA', '媒体文件内容与声明类型不一致')
    }
    const id = input.id ?? randomUUID()
    validateAssetId(id)
    if (this.database.getMediaAsset(id)) {
      throw new MediaStoreError('ASSET_EXISTS', '资产 ID 已存在，生成资产不允许原地覆盖')
    }
    // Validate the media parent before creating anything below it. mkdir()
    // follows an existing symlink, so checking only the final destination
    // would allow a pre-planted runtime/media link to redirect writes.
    const runtimeRealPath = await realpath(this.runtimeDirectory)
    const mediaRealPath = await checkedDirectoryRealPath(this.mediaDirectory, runtimeRealPath)
    const directory = resolve(this.mediaDirectory, stableDirectorySegment(input.projectId))
    await mkdir(directory, { recursive: true })
    const directoryRealPath = await checkedDirectoryRealPath(directory, mediaRealPath)
    const destination = resolve(directory, `${id}.${extensionForMime(detectedMime)}`)
    if (!isWithin(directory, destination) || !isWithin(this.mediaDirectory, destination)) {
      throw new MediaStoreError('UNSAFE_MEDIA_PATH', '资产文件路径越界')
    }
    // A non-symlink directory's real path may differ from its lexical path
    // when the runtime root itself is reached through a symlink. Build a
    // parallel real destination solely for the containment assertion.
    const realDestination = resolve(directoryRealPath, `${id}.${extensionForMime(detectedMime)}`)
    if (!isWithin(mediaRealPath, realDestination)) {
      throw new MediaStoreError('UNSAFE_MEDIA_PATH', '资产文件路径越界')
    }
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(input.bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      // Hard-linking a fully synced temporary file is an atomic no-clobber
      // publish. rename() is not safe here because it silently replaces an
      // existing immutable asset on POSIX filesystems.
      try {
        await link(temporary, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new MediaStoreError('ASSET_EXISTS', '资产文件已存在，拒绝覆盖')
        }
        throw error
      }
      await unlink(temporary)
      const checksum = createHash('sha256').update(input.bytes).digest('hex')
      const filePath = relative(this.runtimeDirectory, destination).split(sep).join('/')
      try {
        return this.database.transaction((database) => {
          options.beforeCreate?.(database)
          const asset = database.createMediaAsset({
            id,
            projectId: input.projectId,
            episodeId: input.episodeId,
            kind: input.kind,
            version: input.version,
            status: input.status,
            filePath,
            mimeType: detectedMime,
            width: input.width,
            height: input.height,
            durationSeconds: input.durationSeconds,
            checksum,
            source: input.source,
            providerId: input.providerId,
            generationJobId: input.generationJobId,
            generationParameters: input.generationParameters,
            sourceRevisionId: input.sourceRevisionId,
            parentAssetId: input.parentAssetId,
          })
          options.afterCreate?.(asset, database)
          return asset
        })
      } catch (error) {
        await unlink(destination).catch(() => undefined)
        throw error
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async openAsset(id: string): Promise<OpenMediaResult> {
    const asset = this.database.getMediaAsset(id)
    if (!asset) throw new MediaStoreError('ASSET_NOT_FOUND', '资产不存在')
    if (!asset.filePath) throw new MediaStoreError('ASSET_FILE_MISSING', '资产尚无本地文件')
    validateStoredRelativePath(asset.filePath)
    const lexicalPath = resolve(this.runtimeDirectory, ...asset.filePath.split('/'))
    if (!isWithin(this.runtimeDirectory, lexicalPath)) {
      throw new MediaStoreError('UNSAFE_MEDIA_PATH', '资产文件路径越界')
    }

    let runtimeRealPath: string
    let fileRealPath: string
    try {
      ;[runtimeRealPath, fileRealPath] = await Promise.all([
        realpath(this.runtimeDirectory),
        realpath(lexicalPath),
      ])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new MediaStoreError('ASSET_FILE_MISSING', '资产文件不存在')
      }
      throw error
    }
    if (!isWithin(runtimeRealPath, fileRealPath)) {
      throw new MediaStoreError('UNSAFE_MEDIA_PATH', '资产文件指向运行目录之外')
    }

    const file = await open(fileRealPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new MediaStoreError('ASSET_FILE_MISSING', '资产路径不是普通文件')
      const prefix = Buffer.alloc(Math.min(Number(info.size), 32))
      if (prefix.length) await file.read(prefix, 0, prefix.length, 0)
      const detectedMime = detectMediaMime(prefix)
      if (asset.mimeType && normalizedAdvertisedMime(asset.mimeType) !== detectedMime) {
        throw new MediaStoreError('INVALID_MEDIA', '资产文件内容与索引类型不一致')
      }
      return { asset, file, size: Number(info.size), mimeType: detectedMime }
    } catch (error) {
      await file.close().catch(() => undefined)
      throw error
    }
  }

  async deleteUnreferencedFile(asset: MediaAssetRecord): Promise<boolean> {
    if (!asset.filePath || asset.source === 'legacy-import') return false
    validateStoredRelativePath(asset.filePath)
    const path = resolve(this.runtimeDirectory, ...asset.filePath.split('/'))
    if (!isWithin(this.mediaDirectory, path)) return false
    await rm(path, { force: true })
    const parent = dirname(path)
    const info = await stat(parent).catch(() => null)
    if (info?.isDirectory()) await rm(parent, { recursive: false }).catch(() => undefined)
    return true
  }
}
