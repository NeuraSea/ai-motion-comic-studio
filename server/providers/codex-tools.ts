import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { downloadPublicImage, SafeImageDownloadError } from '../safe-image-download.js'
import {
  BoundedResponseError,
  readBoundedResponseJson,
  readBoundedResponseText,
  safeUpstreamErrorProjection,
} from './http-transport.js'
import type {
  ImageGenerationInput,
  ImageEditMode,
  ImageProvider,
  ProviderHealth,
  ProviderImage,
  ProviderImageReference,
} from '../types.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
const DEFAULT_MODEL = 'gpt-image-2'
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_IMAGE_RESULTS = 4
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024
const MAX_ENCODED_IMAGE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8
const IMAGE_RESPONSE_OVERHEAD_BYTES = 64 * 1024

export class ImageProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ImageProviderError'
  }
}

export interface CodexToolsProviderOptions {
  baseUrl?: string
  apiKey?: string | null
  model?: string
}

function imageUrl(baseUrl: string, operation: 'generations' | 'edits' | 'variations'): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('CODEX_TOOLS_BASE_URL 必须使用 http 或 https')
  }
  if (url.username || url.password) throw new Error('CODEX_TOOLS_BASE_URL 不能包含凭据')

  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? `${path}/images/${operation}` : `${path}/v1/images/${operation}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function modelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('CODEX_TOOLS_BASE_URL 必须使用 http 或 https')
  }
  if (url.username || url.password) throw new Error('CODEX_TOOLS_BASE_URL 不能包含凭据')
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? `${path}/models` : `${path}/v1/models`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function cleanApiKey(value: string | null | undefined): string | null {
  const key = value?.trim()
  return key ? key : null
}

export async function loadCodexToolsApiKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const fromEnvironment = cleanApiKey(env.CODEX_TOOLS_API_KEY)
  if (fromEnvironment) return fromEnvironment

  const keyPath = env.CODEX_TOOLS_API_KEY_FILE?.trim() ||
    join(homedir(), 'Library', 'Application Support', 'com.carry.codex-tools', 'api-proxy.key')
  try {
    return cleanApiKey(await readFile(keyPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('无法读取 Codex Tools API key 文件', { cause: error })
  }
}

/**
 * Live credential access for the local Codex Tools proxy.
 *
 * Deliberately do not memoize either environment or file-backed credentials:
 * the proxy can be installed, logged into, rotated, or logged out while this
 * server keeps running. Every call observes the current credential and the
 * returned object never retains or exposes a secret value.
 */
export function createCodexToolsCredentialSource(
  env: NodeJS.ProcessEnv = process.env,
): { load(): Promise<string | null>; exists(): Promise<boolean> } {
  return {
    load: () => loadCodexToolsApiKey(env),
    exists: async () => (await loadCodexToolsApiKey(env)) !== null,
  }
}

function maximumImageResponseBytes(requestedCount: number): number {
  const count = Number.isSafeInteger(requestedCount)
    ? Math.min(Math.max(requestedCount, 1), MAX_IMAGE_RESULTS)
    : 1
  return IMAGE_RESPONSE_OVERHEAD_BYTES + count * MAX_ENCODED_IMAGE_BYTES
}

function detectMimeType(bytes: Uint8Array, advertised?: string | null): string {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 6)).toString('ascii').startsWith('GIF8')) return 'image/gif'
  if (advertised?.toLowerCase().startsWith('image/')) return advertised.split(';', 1)[0].toLowerCase()
  throw new ImageProviderError('INVALID_IMAGE_RESPONSE', '图片服务返回了无法识别的文件', true)
}

function decodeBase64Image(value: string): ProviderImage {
  const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(value)
  const encoded = (dataUrl ? dataUrl[2] : value).replace(/\s+/g, '')
  if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8 || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) {
    throw new ImageProviderError('INVALID_IMAGE_RESPONSE', '图片服务返回了无效的 base64 数据', true)
  }

  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new ImageProviderError('IMAGE_TOO_LARGE', '生成图片超过 30MB 限制', false)
  }
  return { bytes, mimeType: detectMimeType(bytes, dataUrl?.[1]) }
}

async function downloadImage(urlValue: string, signal: AbortSignal): Promise<ProviderImage> {
  try {
    const image = await downloadPublicImage(urlValue, signal, MAX_IMAGE_BYTES)
    return { bytes: image.bytes, mimeType: detectMimeType(image.bytes, image.contentType) }
  } catch (error) {
    if (error instanceof SafeImageDownloadError) {
      throw new ImageProviderError(error.code, error.message, error.retryable)
    }
    throw error
  }
}

async function parseImageResponse(
  response: Response,
  signal: AbortSignal,
  operation: 'generations' | 'edits' | 'variations',
  maximumResponseBytes: number,
): Promise<ProviderImage[]> {
  if (!response.ok) {
    // The status is sufficient for a stable public classification. Never
    // persist arbitrary gateway text, which may echo credentials or prompts.
    await readBoundedResponseText(response, MAX_ERROR_RESPONSE_BYTES).catch(() => undefined)
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    if (operation !== 'generations' && [404, 405, 415, 501].includes(response.status)) {
      throw new ImageProviderError(
        operation === 'variations' ? 'IMAGE_VARIATIONS_UNSUPPORTED' : 'REFERENCE_IMAGES_UNSUPPORTED',
        operation === 'variations'
          ? '当前图片 Provider 不支持 OpenAI 兼容的 images/variations 协议'
          : '当前图片 Provider 不支持 OpenAI 兼容的 images/edits 参考图协议',
        false,
      )
    }
    const code = response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH_FAILED' : 'UPSTREAM_ERROR'
    throw new ImageProviderError(
      code,
      safeUpstreamErrorProjection('image', response.status),
      retryable,
    )
  }

  let body: unknown
  try {
    body = await readBoundedResponseJson(response, maximumResponseBytes)
  } catch (error) {
    if (error instanceof BoundedResponseError && error.code === 'BODY_TOO_LARGE') {
      throw new ImageProviderError('IMAGE_TOO_LARGE', '图片服务响应超过大小限制', false)
    }
    if (error instanceof BoundedResponseError && error.code === 'BODY_READ_FAILED') {
      throw new ImageProviderError('UPSTREAM_UNAVAILABLE', '图片服务响应读取中断', true)
    }
    if (error instanceof BoundedResponseError) {
      throw new ImageProviderError('INVALID_IMAGE_RESPONSE', '图片服务返回了无效 JSON', true)
    }
    throw error
  }

  const data = body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
    ? (body as { data: unknown[] }).data
    : null
  if (!data?.length) {
    throw new ImageProviderError('INVALID_IMAGE_RESPONSE', '图片服务未返回图片', true)
  }

  const images: ProviderImage[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as { b64_json?: unknown; url?: unknown; revised_prompt?: unknown }
    let image: ProviderImage | undefined
    if (typeof candidate.b64_json === 'string') image = decodeBase64Image(candidate.b64_json)
    else if (typeof candidate.url === 'string') image = await downloadImage(candidate.url, signal)
    if (!image) continue
    if (typeof candidate.revised_prompt === 'string') image.revisedPrompt = candidate.revised_prompt
    images.push(image)
  }

  if (!images.length) {
    throw new ImageProviderError('INVALID_IMAGE_RESPONSE', '图片服务响应不包含 b64_json 或 URL', true)
  }
  return images
}

function appendImage(form: FormData, reference: ProviderImageReference, name: string): void {
  const uploadBytes = new Uint8Array(reference.bytes.byteLength)
  uploadBytes.set(reference.bytes)
  const extension = reference.mimeType === 'image/jpeg'
    ? 'jpg'
    : reference.mimeType === 'image/webp'
      ? 'webp'
      : reference.mimeType === 'image/gif'
        ? 'gif'
        : 'png'
  form.append(
    'image',
    new Blob([uploadBytes.buffer], { type: reference.mimeType }),
    `${name}.${extension}`,
  )
}

export class CodexToolsImageProvider implements ImageProvider {
  readonly name = 'codex-tools'
  readonly model: string
  readonly configured: boolean
  readonly supportsImageReferences = true
  readonly supportsImageEdits = true
  readonly supportsImageVariations = true
  private readonly apiKey: string | null
  private readonly generationsEndpoint: string
  private readonly editsEndpoint: string
  private readonly variationsEndpoint: string
  private readonly modelsEndpoint: string
  private healthCache?: { expiresAt: number; value: ProviderHealth }

  constructor(options: CodexToolsProviderOptions = {}) {
    this.apiKey = cleanApiKey(options.apiKey)
    this.configured = this.apiKey !== null
    this.model = options.model?.trim() || DEFAULT_MODEL
    const baseUrl = options.baseUrl?.trim() || DEFAULT_BASE_URL
    this.generationsEndpoint = imageUrl(baseUrl, 'generations')
    this.editsEndpoint = imageUrl(baseUrl, 'edits')
    this.variationsEndpoint = imageUrl(baseUrl, 'variations')
    this.modelsEndpoint = modelsUrl(baseUrl)
  }

  async health(): Promise<ProviderHealth> {
    if (!this.apiKey) {
      return { status: 'unavailable', message: '未配置 Codex Tools API key' }
    }
    if (this.healthCache && this.healthCache.expiresAt > Date.now()) return this.healthCache.value

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    timer.unref()
    let value: ProviderHealth
    try {
      const response = await fetch(this.modelsEndpoint, {
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
        signal: controller.signal,
      })
      await response.body?.cancel().catch(() => undefined)
      if (response.ok) value = { status: 'ok', message: 'Codex Tools 图片服务可用' }
      else if (response.status === 401 || response.status === 403) {
        value = { status: 'unavailable', message: 'Codex Tools API key 无效或已禁用' }
      } else {
        value = { status: 'degraded', message: `Codex Tools 响应异常 (${response.status})` }
      }
    } catch {
      value = { status: 'unavailable', message: '无法连接 Codex Tools，请确认 API 反代已启动' }
    } finally {
      clearTimeout(timer)
    }
    this.healthCache = { expiresAt: Date.now() + 3_000, value }
    return value
  }

  async generate(
    input: ImageGenerationInput,
    signal: AbortSignal,
    references: readonly ProviderImageReference[] = [],
  ): Promise<ProviderImage[]> {
    if (!this.apiKey) {
      throw new ImageProviderError(
        'PROVIDER_NOT_CONFIGURED',
        '未配置 Codex Tools API key，请启动 Codex Tools 或设置 CODEX_TOOLS_API_KEY',
        false,
      )
    }

    let response: Response
    try {
      if (references.length > 0) {
        const form = new FormData()
        form.set('model', this.model)
        form.set('prompt', input.prompt)
        form.set('n', String(input.count))
        form.set('size', input.size)
        form.set('quality', input.quality)
        form.set('response_format', 'b64_json')
        form.set('output_format', 'png')
        references.forEach((reference, index) => appendImage(form, reference, `reference-${index + 1}`))
        response = await fetch(this.editsEndpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: 'application/json',
          },
          body: form,
          signal,
        })
      } else {
        response = await fetch(this.generationsEndpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            prompt: input.prompt,
            n: input.count,
            size: input.size,
            quality: input.quality,
            response_format: 'b64_json',
            output_format: 'png',
          }),
          signal,
        })
      }
    } catch (error) {
      if (signal.aborted) throw error
      throw new ImageProviderError('UPSTREAM_UNAVAILABLE', '无法连接 Codex Tools 图片服务', true)
    }

    return parseImageResponse(
      response,
      signal,
      references.length > 0 ? 'edits' : 'generations',
      maximumImageResponseBytes(input.count),
    )
  }

  async edit(
    input: ImageGenerationInput,
    signal: AbortSignal,
    source: ProviderImageReference,
    references: readonly ProviderImageReference[],
    mode: ImageEditMode,
  ): Promise<ProviderImage[]> {
    if (!this.apiKey) {
      throw new ImageProviderError('PROVIDER_NOT_CONFIGURED', '未配置 Codex Tools API key', false)
    }
    if (mode === 'variation' && references.length > 0) {
      throw new ImageProviderError(
        'INVALID_VARIATION_REFERENCES',
        'images/variations 协议只接受一张源图；多参考图请使用 edit 模式',
        false,
      )
    }
    const form = new FormData()
    form.set('model', this.model)
    form.set('n', String(input.count))
    form.set('size', input.size)
    form.set('response_format', 'b64_json')
    if (mode === 'edit') {
      form.set('prompt', input.prompt)
      form.set('quality', input.quality)
      form.set('output_format', 'png')
    }
    appendImage(form, source, 'source')
    if (mode === 'edit') {
      references.forEach((reference, index) => appendImage(form, reference, `reference-${index + 1}`))
    }
    let response: Response
    try {
      response = await fetch(mode === 'variation' ? this.variationsEndpoint : this.editsEndpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
        body: form,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw new ImageProviderError('UPSTREAM_UNAVAILABLE', '无法连接 Codex Tools 图片服务', true)
    }
    return parseImageResponse(
      response,
      signal,
      mode === 'variation' ? 'variations' : 'edits',
      maximumImageResponseBytes(input.count),
    )
  }
}
