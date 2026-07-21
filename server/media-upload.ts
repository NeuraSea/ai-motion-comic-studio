import {
  AudioDurationProbeError,
  probeAudioDuration,
  type AudioDurationProbe,
} from './audio-duration.js'
import type { ManjuDatabase, MediaAssetRecord } from './database.js'
import {
  detectMediaMime,
  MediaStore,
  MediaStoreError,
} from './media.js'

export const DEFAULT_USER_AUDIO_UPLOAD_MAX_BYTES = 64 * 1024 * 1024

export const USER_AUDIO_ASSET_KINDS = ['bgm', 'sfx'] as const
export type UserAudioAssetKind = (typeof USER_AUDIO_ASSET_KINDS)[number]
export type UserAudioMimeType = 'audio/mpeg' | 'audio/wav'

export class MediaUploadError extends Error {
  constructor(
    readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'EPISODE_NOT_FOUND'
      | 'INVALID_AUDIO_KIND'
      | 'INVALID_UPLOAD_NAME'
      | 'UNSUPPORTED_AUDIO_TYPE'
      | 'INVALID_AUDIO'
      | 'AUDIO_PROBE_UNAVAILABLE',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MediaUploadError'
  }
}

export interface UploadUserAudioInput {
  projectId: string
  episodeId: string
  kind: UserAudioAssetKind
  bytes: Uint8Array
  mimeType: UserAudioMimeType
  /** Display-only metadata. It is never used to construct a file path. */
  originalFileName?: string
}

export interface UserMediaUploadServiceOptions {
  audioDurationProbe?: AudioDurationProbe
  maxAudioBytes?: number
}

export function parseUserAudioAssetKind(value: string): UserAudioAssetKind {
  if ((USER_AUDIO_ASSET_KINDS as readonly string[]).includes(value)) {
    return value as UserAudioAssetKind
  }
  throw new MediaUploadError('INVALID_AUDIO_KIND', '音频类型仅支持 bgm 或 sfx')
}

export function normalizeUserAudioMimeType(value: string | undefined): UserAudioMimeType {
  const mimeType = value?.split(';', 1)[0]?.trim().toLowerCase()
  if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') return 'audio/mpeg'
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav' || mimeType === 'audio/wave') return 'audio/wav'
  throw new MediaUploadError(
    'UNSUPPORTED_AUDIO_TYPE',
    '音频上传仅支持 MP3 或 WAV，并必须声明正确的 Content-Type',
  )
}

export function normalizeUploadDisplayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > 200
    || /[\u0000-\u001f\u007f/\\]/.test(normalized)
    || normalized === '.'
    || normalized === '..'
  ) {
    throw new MediaUploadError('INVALID_UPLOAD_NAME', '上传文件名格式无效')
  }
  return normalized
}

/**
 * Validates and publishes user-owned audio. No caller-controlled file system
 * path or Asset ID is accepted by this boundary.
 */
export class UserMediaUploadService {
  private readonly audioDurationProbe: AudioDurationProbe
  private readonly maxAudioBytes: number

  constructor(
    private readonly database: ManjuDatabase,
    private readonly mediaStore: MediaStore,
    options: UserMediaUploadServiceOptions = {},
  ) {
    this.audioDurationProbe = options.audioDurationProbe ?? probeAudioDuration
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_USER_AUDIO_UPLOAD_MAX_BYTES
    if (!Number.isSafeInteger(this.maxAudioBytes) || this.maxAudioBytes < 1) {
      throw new RangeError('maxAudioBytes must be a positive integer')
    }
  }

  async uploadAudio(input: UploadUserAudioInput): Promise<MediaAssetRecord> {
    if (!this.database.getProject(input.projectId)) {
      throw new MediaUploadError('PROJECT_NOT_FOUND', '项目不存在')
    }
    const episode = this.database.withSql((sql) => sql.get(
      'SELECT id FROM episodes WHERE id = ? AND project_id = ?',
      input.episodeId,
      input.projectId,
    ))
    if (!episode) {
      throw new MediaUploadError('EPISODE_NOT_FOUND', '分集不存在或不属于指定项目')
    }
    // Keep runtime validation even though TypeScript callers see a union.
    parseUserAudioAssetKind(input.kind)
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new MediaUploadError('INVALID_AUDIO', '音频文件为空')
    }
    if (input.bytes.byteLength > this.maxAudioBytes) {
      throw new MediaStoreError(
        'MEDIA_TOO_LARGE',
        `音频文件不能超过 ${this.maxAudioBytes} 字节`,
      )
    }

    let detectedMime: string
    try {
      detectedMime = detectMediaMime(input.bytes)
    } catch (error) {
      if (error instanceof MediaStoreError) {
        throw new MediaUploadError('INVALID_AUDIO', '无法识别音频文件内容', { cause: error })
      }
      throw error
    }
    if (detectedMime !== input.mimeType || (detectedMime !== 'audio/mpeg' && detectedMime !== 'audio/wav')) {
      throw new MediaUploadError('INVALID_AUDIO', '音频文件内容与声明类型不一致')
    }

    let durationSeconds: number
    try {
      durationSeconds = await this.audioDurationProbe(input.bytes, input.mimeType)
    } catch (error) {
      if (error instanceof AudioDurationProbeError) {
        if (error.code === 'BINARY_UNAVAILABLE') {
          throw new MediaUploadError(
            'AUDIO_PROBE_UNAVAILABLE',
            '服务端暂时无法安全验证音频',
            { cause: error },
          )
        }
        throw new MediaUploadError('INVALID_AUDIO', '音频无法通过 ffprobe 验证', { cause: error })
      }
      throw error
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3_600) {
      throw new MediaUploadError('INVALID_AUDIO', 'ffprobe 返回的音频时长无效')
    }

    return this.mediaStore.save({
      projectId: input.projectId,
      episodeId: input.episodeId,
      kind: input.kind,
      bytes: input.bytes,
      mimeType: input.mimeType,
      durationSeconds,
      source: 'upload',
      generationParameters: {
        uploadKind: input.kind,
        ...(input.originalFileName ? { originalFileName: input.originalFileName } : {}),
      },
    })
  }
}
