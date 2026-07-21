export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const
export type ImageSize = (typeof IMAGE_SIZES)[number]

export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const
export type ImageQuality = (typeof IMAGE_QUALITIES)[number]

export interface ImageGenerationInput {
  prompt: string
  size: ImageSize
  quality: ImageQuality
  count: number
  metadata?: JsonObject
}

export type ImageJobStatus =
  | 'queued'
  | 'running'
  | 'waiting_provider'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface GeneratedImageAsset {
  id: string
  url: string
  mimeType: string
  width?: number
  height?: number
  revisedPrompt?: string
}

export interface ImageJobError {
  code: string
  message: string
  retryable: boolean
}

export interface ImageJob {
  id: string
  type: 'image.generate'
  status: ImageJobStatus
  progress: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  attempt: number
  input: ImageGenerationInput
  output?: {
    images: GeneratedImageAsset[]
  }
  error?: ImageJobError
  retryOf?: string
}

export interface PersistedState {
  version: 1
  project: JsonObject
  jobs: ImageJob[]
}

export interface ProviderImage {
  bytes: Uint8Array
  mimeType: string
  revisedPrompt?: string
}

/**
 * An image reference already resolved from Manju's controlled MediaStore.
 * Providers never receive a client supplied path or URL.
 */
export interface ProviderImageReference {
  bytes: Uint8Array
  mimeType: string
}

export type ImageEditMode = 'edit' | 'variation'

export type ProviderHealthStatus = 'ok' | 'degraded' | 'unavailable'

export interface ProviderHealth {
  status: ProviderHealthStatus
  message: string
}

/**
 * The image queue depends only on this interface. A Seedance-backed provider can
 * be added without changing the HTTP API, persistence, or queue implementation.
 */
export interface ImageProvider {
  readonly name: string
  readonly model: string
  readonly configured: boolean
  /** Must be explicitly true; otherwise the worker refuses reference jobs. */
  readonly supportsImageReferences?: boolean
  /** Explicit adapter capability gates for paid immutable asset edits. */
  readonly supportsImageEdits?: boolean
  readonly supportsImageVariations?: boolean
  health(): Promise<ProviderHealth>
  generate(
    input: ImageGenerationInput,
    signal: AbortSignal,
    references?: readonly ProviderImageReference[],
  ): Promise<ProviderImage[]>
  /**
   * Edit one controlled source image. Both the source and additional
   * references have already been resolved to bytes from MediaStore; adapters
   * must never resolve client supplied paths or URLs.
   */
  edit?(
    input: ImageGenerationInput,
    signal: AbortSignal,
    source: ProviderImageReference,
    references: readonly ProviderImageReference[],
    mode: ImageEditMode,
  ): Promise<ProviderImage[]>
}
