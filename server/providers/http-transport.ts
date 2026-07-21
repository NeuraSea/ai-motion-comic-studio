export type BoundedResponseErrorCode =
  | 'BODY_MISSING'
  | 'BODY_TOO_LARGE'
  | 'BODY_READ_FAILED'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'

/**
 * A body-reader failure that is safe to classify or persist. It deliberately
 * never retains the response body or the underlying stream error as `cause`.
 */
export class BoundedResponseError extends Error {
  constructor(readonly code: BoundedResponseErrorCode) {
    super(code)
    this.name = 'BoundedResponseError'
  }
}

export class ProviderRequestTimeoutError extends Error {
  constructor() {
    super('Provider request timed out')
    this.name = 'ProviderRequestTimeoutError'
  }
}

function positiveMaximumBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('maximumBytes must be a positive safe integer')
  }
  return value
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30 * 60 * 1_000) {
    throw new TypeError('timeoutMs must be between 1 and 1800000')
  }
  return value
}

function callerAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  await reader.cancel().catch(() => undefined)
}

/**
 * Reads a Fetch response as UTF-8 while counting streamed bytes before they
 * are decoded. This bounds chunked and decompressed responses even when an
 * upstream omits or lies about Content-Length.
 */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const limit = positiveMaximumBytes(maximumBytes)
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared.trim())) {
    const declaredBytes = Number(declared)
    if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
      await response.body?.cancel().catch(() => undefined)
      throw new BoundedResponseError('BODY_TOO_LARGE')
    }
  }
  if (!response.body) throw new BoundedResponseError('BODY_MISSING')

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let decodedChunks: string[] = []
  let decodedText = ''
  let byteCount = 0
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        await cancelReader(reader)
        throw new BoundedResponseError('BODY_READ_FAILED')
      }
      if (chunk.done) break
      byteCount += chunk.value.byteLength
      if (byteCount > limit) {
        await cancelReader(reader)
        throw new BoundedResponseError('BODY_TOO_LARGE')
      }
      try {
        decodedChunks.push(decoder.decode(chunk.value, { stream: true }))
        if (decodedChunks.length >= 4_096) {
          decodedText += decodedChunks.join('')
          decodedChunks = []
        }
      } catch {
        await cancelReader(reader)
        throw new BoundedResponseError('INVALID_UTF8')
      }
    }
    try {
      decodedChunks.push(decoder.decode())
    } catch {
      throw new BoundedResponseError('INVALID_UTF8')
    }
    return decodedText + decodedChunks.join('')
  } finally {
    reader.releaseLock()
  }
}

export async function readBoundedResponseJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maximumBytes)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BoundedResponseError('INVALID_JSON')
  }
}

/**
 * Bounds a complete Provider exchange, including response-body consumption.
 * The caller's cancellation reason always wins over the adapter deadline.
 */
export async function runWithProviderRequestTimeout<T>(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = positiveTimeout(timeoutMs)
  if (callerSignal?.aborted) throw callerAbortReason(callerSignal)

  const timeoutController = new AbortController()
  const requestSignal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal
  const timeoutError = new ProviderRequestTimeoutError()
  let callerAbort: (() => void) | undefined
  const callerCancellation = callerSignal
    ? new Promise<never>((_resolve, reject) => {
        callerAbort = () => reject(callerAbortReason(callerSignal))
        callerSignal.addEventListener('abort', callerAbort, { once: true })
      })
    : null
  const timeout = setTimeout(() => timeoutController.abort(timeoutError), deadline)
  timeout.unref()
  const deadlineReached = new Promise<never>((_resolve, reject) => {
    timeoutController.signal.addEventListener('abort', () => reject(timeoutError), { once: true })
  })

  try {
    const candidates: Promise<T>[] = [Promise.resolve().then(() => operation(requestSignal)), deadlineReached]
    if (callerCancellation) candidates.push(callerCancellation)
    return await Promise.race(candidates)
  } catch (error) {
    if (callerSignal?.aborted) throw callerAbortReason(callerSignal)
    if (timeoutController.signal.aborted) throw timeoutError
    throw error
  } finally {
    clearTimeout(timeout)
    if (callerAbort && callerSignal) callerSignal.removeEventListener('abort', callerAbort)
  }
}

/**
 * Provider error bodies are untrusted and commonly echo credentials, local
 * paths, prompts, or source text. Persist only our allow-listed status message.
 */
export function safeUpstreamErrorProjection(
  provider: 'text' | 'image',
  status: number,
): string {
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : 500
  if (safeStatus === 401 || safeStatus === 403) {
    return provider === 'text'
      ? '文本 Provider API Key 无效或无权访问'
      : '图片 Provider API Key 无效或无权访问'
  }
  return provider === 'text'
    ? `文本 Provider 请求失败 (${safeStatus})`
    : `图片服务请求失败 (${safeStatus})`
}
