import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { ImageProviderError } from './providers/codex-tools.js'
import { AtomicStateStore } from './store.js'
import type { GeneratedImageAsset, ImageJob, ImageProvider, ProviderImage } from './types.js'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(value as number, 10_000), 30 * 60 * 1_000)
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function dimensions(image: ProviderImage): { width?: number; height?: number } {
  const bytes = image.bytes
  if (image.mimeType === 'image/png' && bytes.length >= 24) {
    return {
      width: Buffer.from(bytes).readUInt32BE(16),
      height: Buffer.from(bytes).readUInt32BE(20),
    }
  }
  if (image.mimeType === 'image/gif' && bytes.length >= 10) {
    return {
      width: bytes[6] | (bytes[7] << 8),
      height: bytes[8] | (bytes[9] << 8),
    }
  }
  if (image.mimeType === 'image/webp' && bytes.length >= 30) {
    const chunk = Buffer.from(bytes.subarray(12, 16)).toString('ascii')
    if (chunk === 'VP8X') {
      return {
        width: readUint24LE(bytes, 24) + 1,
        height: readUint24LE(bytes, 27) + 1,
      }
    }
  }
  if (image.mimeType === 'image/jpeg' && bytes.length >= 10) {
    const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1]
      if (startOfFrameMarkers.has(marker)) {
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

async function saveImageAtomically(
  directory: string,
  job: ImageJob,
  image: ProviderImage,
  index: number,
): Promise<GeneratedImageAsset> {
  const id = randomUUID()
  const fileName = `${job.id}-${index + 1}-${id}.${imageExtension(image.mimeType)}`
  const destination = join(directory, fileName)
  const temporary = `${destination}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(image.bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }

  return {
    id,
    url: `/generated/${fileName}`,
    mimeType: image.mimeType,
    ...dimensions(image),
    ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
  }
}

export class ImageJobQueue {
  private readonly pending: string[] = []
  private readonly enqueued = new Set<string>()
  private readonly timeoutMs: number
  private active = false

  constructor(
    private readonly store: AtomicStateStore,
    private readonly provider: ImageProvider,
    private readonly generatedDirectory: string,
    timeoutMs?: number,
  ) {
    this.timeoutMs = clampTimeout(timeoutMs)
  }

  async init(): Promise<void> {
    await mkdir(this.generatedDirectory, { recursive: true })
    for (const id of this.store.listQueuedJobIds()) this.enqueue(id)
  }

  enqueue(id: string): void {
    if (this.enqueued.has(id)) return
    this.enqueued.add(id)
    this.pending.push(id)
    void this.drain()
  }

  getStats(): { running: boolean; pending: number } {
    return { running: this.active, pending: this.pending.length }
  }

  private async drain(): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      let id: string | undefined
      while ((id = this.pending.shift())) {
        this.enqueued.delete(id)
        await this.run(id)
      }
    } finally {
      this.active = false
      if (this.pending.length) void this.drain()
    }
  }

  private async run(id: string): Promise<void> {
    const queued = this.store.getJob(id)
    if (!queued || queued.status !== 'queued') return

    const startedAt = new Date().toISOString()
    const job = await this.store.updateJob(id, {
      status: 'running',
      progress: 10,
      startedAt,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('image generation timeout')), this.timeoutMs)
    timer.unref()
    try {
      const generated = await this.provider.generate(job.input, controller.signal)
      const selected = generated.slice(0, job.input.count)
      if (!selected.length) {
        throw new ImageProviderError('INVALID_IMAGE_RESPONSE', '图片服务未返回可用图片', true)
      }

      const images: GeneratedImageAsset[] = []
      for (const [index, image] of selected.entries()) {
        images.push(await saveImageAtomically(this.generatedDirectory, job, image, index))
      }
      const completedAt = new Date().toISOString()
      await this.store.updateJob(id, {
        status: 'succeeded',
        progress: 100,
        completedAt,
        output: { images },
      })
    } catch (error) {
      const timedOut = controller.signal.aborted
      const providerError = error instanceof ImageProviderError ? error : null
      const completedAt = new Date().toISOString()
      await this.store.updateJob(id, {
        status: 'failed',
        progress: 100,
        completedAt,
        error: timedOut
          ? { code: 'GENERATION_TIMEOUT', message: '图片生成超时，请稍后重试', retryable: true }
          : providerError
            ? { code: providerError.code, message: providerError.message, retryable: providerError.retryable }
            : { code: 'GENERATION_FAILED', message: '图片生成失败，请稍后重试', retryable: true },
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
