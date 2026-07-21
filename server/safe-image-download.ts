import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

const MAX_REDIRECTS = 4
const SOCKET_TIMEOUT_MS = 15_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export class SafeImageDownloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'SafeImageDownloadError'
  }
}

interface ResolvedAddress {
  address: string
  family: 4 | 6
}

interface DownloadDependencies {
  lookup(hostname: string): Promise<Array<{ address: string; family: number }>>
  request(
    url: URL,
    address: ResolvedAddress,
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<PinnedResponse>
}

export interface DownloadedImage {
  bytes: Uint8Array
  contentType: string | null
}

export interface DownloadedPublicResource {
  bytes: Uint8Array
  contentType: string | null
}

export class SafePublicDownloadError extends Error {
  constructor(
    readonly code:
      | 'INVALID_RESOURCE_URL'
      | 'UNSAFE_RESOURCE_URL'
      | 'RESOURCE_DOWNLOAD_FAILED'
      | 'RESOURCE_TOO_LARGE',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'SafePublicDownloadError'
  }
}

interface PublicDownloadDependencies {
  lookup(hostname: string): Promise<Array<{ address: string; family: number }>>
  request(
    url: URL,
    address: ResolvedAddress,
    signal: AbortSignal,
    options: { maxBytes: number; accept: string; userAgent: string },
  ): Promise<PublicPinnedResponse>
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((part) => Number(part))
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? bytes : null
}

function isPublicIpv4Bytes(bytes: number[]): boolean {
  const [a, b, c] = bytes
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function parseIpv6(address: string): number[] | null {
  let normalized = stripIpv6Brackets(address).toLowerCase()
  if (normalized.includes('%')) return null

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':')
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1))
    if (!ipv4) return null
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16)
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16)
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`
  }

  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const parseHalf = (half: string) => half
    ? half.split(':').map((part) => Number.parseInt(part, 16))
    : []
  const left = parseHalf(halves[0])
  const right = parseHalf(halves[1] ?? '')
  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0
  const words = [...left, ...Array.from({ length: zeroCount }, () => 0), ...right]
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return null
  }
  return words
}

function embeddedIpv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

function isPublicIpv6(address: string): boolean {
  const words = parseIpv6(address)
  if (!words) return false

  // IPv4-compatible and IPv4-mapped IPv6 addresses inherit IPv4 safety.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    return isPublicIpv4Bytes(embeddedIpv4(words[6], words[7]))
  }

  // Only globally routable 2000::/3 is accepted. This excludes loopback,
  // link-local, ULA, multicast, site-local and NAT64/private transition space.
  if ((words[0] & 0xe000) !== 0x2000) return false
  if (words[0] === 0x2001 && words[1] === 0x0000) return false // Teredo
  if (words[0] === 0x2001 && words[1] === 0x0002) return false // benchmarking
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false // documentation
  if (words[0] === 0x2002) return isPublicIpv4Bytes(embeddedIpv4(words[1], words[2])) // 6to4
  return true
}

/** Returns true only for globally routable IP literals. */
export function isPublicIpAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address)
  const family = isIP(normalized)
  if (family === 4) {
    const bytes = parseIpv4(normalized)
    return !!bytes && isPublicIpv4Bytes(bytes)
  }
  return family === 6 && isPublicIpv6(normalized)
}

function isBlockedHostname(hostname: string): boolean {
  const value = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/, '')
  return value === 'localhost' ||
    value === 'localhost.localdomain' ||
    value === 'instance-data' ||
    value === 'metadata.google.internal' ||
    value.endsWith('.localhost') ||
    value.endsWith('.local') ||
    value.endsWith('.internal') ||
    value.endsWith('.lan') ||
    value.endsWith('.home')
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function resolvePublicAddresses(
  hostname: string,
  signal: AbortSignal,
  lookup: DownloadDependencies['lookup'],
): Promise<ResolvedAddress[]> {
  const normalized = stripIpv6Brackets(hostname)
  if (isBlockedHostname(normalized)) {
    throw new SafeImageDownloadError('UNSAFE_IMAGE_URL', '图片 URL 指向本机或内部网络', false)
  }

  const literalFamily = isIP(normalized)
  let addresses: ResolvedAddress[]
  if (literalFamily) {
    addresses = [{ address: normalized, family: literalFamily as 4 | 6 }]
  } else {
    try {
      const resolved = await abortable(lookup(normalized), signal)
      addresses = resolved
        .filter((entry): entry is typeof entry & { family: 4 | 6 } => entry.family === 4 || entry.family === 6)
        .map(({ address, family }) => ({ address, family }))
    } catch (error) {
      if (signal.aborted) throw error
      throw new SafeImageDownloadError('IMAGE_DOWNLOAD_FAILED', '无法解析图片下载地址', true)
    }
  }
  if (!addresses.length) {
    throw new SafeImageDownloadError('IMAGE_DOWNLOAD_FAILED', '无法解析图片下载地址', true)
  }
  if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new SafeImageDownloadError('UNSAFE_IMAGE_URL', '图片 URL 解析到本机、私网、link-local 或 metadata 地址', false)
  }
  return addresses.sort((left, right) => left.family - right.family)
}

function validateUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeImageDownloadError('UNSAFE_IMAGE_URL', '图片 URL 协议不受支持', false)
  }
  if (url.username || url.password) {
    throw new SafeImageDownloadError('UNSAFE_IMAGE_URL', '图片 URL 不能包含凭据', false)
  }
}

async function readLimitedBody(response: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.destroy()
    throw new SafeImageDownloadError('IMAGE_TOO_LARGE', '生成图片超过 30MB 限制', false)
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      response.destroy()
      throw new SafeImageDownloadError('IMAGE_TOO_LARGE', '生成图片超过 30MB 限制', false)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}

type PinnedResponse =
  | { kind: 'redirect'; location: string }
  | { kind: 'image'; image: DownloadedImage }

type PublicPinnedResponse =
  | { kind: 'redirect'; location: string }
  | { kind: 'resource'; resource: DownloadedPublicResource }

async function requestPinned(
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
  maxBytes: number,
): Promise<PinnedResponse> {
  return new Promise<PinnedResponse>((resolve, reject) => {
    const originalHostname = stripIpv6Brackets(url.hostname)
    const options = {
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        accept: 'image/png,image/jpeg,image/webp,image/gif,image/*;q=0.8',
        host: url.host,
        'user-agent': 'manju-studio-image-fetcher/0.1',
      },
      signal,
    }
    const onResponse = (response: IncomingMessage) => {
      const status = response.statusCode ?? 0
      if (REDIRECT_STATUSES.has(status)) {
        const location = response.headers.location
        response.resume()
        if (!location) {
          reject(new SafeImageDownloadError('IMAGE_DOWNLOAD_FAILED', '图片下载重定向缺少地址', true))
          return
        }
        resolve({ kind: 'redirect', location })
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new SafeImageDownloadError('IMAGE_DOWNLOAD_FAILED', `图片下载失败 (${status})`, status >= 500))
        return
      }
      void readLimitedBody(response, maxBytes).then((bytes) => {
        const rawType = response.headers['content-type']
        const contentType = Array.isArray(rawType) ? rawType[0] ?? null : rawType ?? null
        resolve({ kind: 'image', image: { bytes, contentType } })
      }, reject)
    }

    const request = url.protocol === 'https:'
      ? httpsRequest({
          ...options,
          ...(isIP(originalHostname) ? {} : { servername: originalHostname }),
        }, onResponse)
      : httpRequest(options, onResponse)
    request.setTimeout(SOCKET_TIMEOUT_MS, () => {
      request.destroy(new SafeImageDownloadError('IMAGE_DOWNLOAD_FAILED', '图片下载连接超时', true))
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Downloads an image without allowing DNS rebinding or redirect-based SSRF.
 * Every redirect target is resolved and checked again, and the socket connects
 * directly to the exact validated IP instead of performing a second DNS lookup.
 */
export async function downloadPublicImage(
  urlValue: string,
  signal: AbortSignal,
  maxBytes: number,
  dependencies: DownloadDependencies = {
    lookup: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
    request: requestPinned,
  },
): Promise<DownloadedImage> {
  let current: URL
  try {
    current = new URL(urlValue)
  } catch {
    throw new SafeImageDownloadError('INVALID_IMAGE_RESPONSE', '图片服务返回了无效 URL', true)
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    validateUrl(current)
    const addresses = await resolvePublicAddresses(current.hostname, signal, dependencies.lookup)
    let result: PinnedResponse
    try {
      result = await dependencies.request(current, addresses[0], signal, maxBytes)
    } catch (error) {
      if (signal.aborted || error instanceof SafeImageDownloadError) throw error
      throw new SafeImageDownloadError('IMAGE_DOWNLOAD_FAILED', '图片下载失败', true)
    }
    if (result.kind === 'image') return result.image
    if (redirects === MAX_REDIRECTS) {
      throw new SafeImageDownloadError('IMAGE_DOWNLOAD_FAILED', '图片下载重定向次数过多', true)
    }
    try {
      current = new URL(result.location, current)
    } catch {
      throw new SafeImageDownloadError('INVALID_IMAGE_RESPONSE', '图片重定向 URL 无效', true)
    }
  }
  throw new SafeImageDownloadError('IMAGE_DOWNLOAD_FAILED', '图片下载失败', true)
}

function publicResourceError(error: unknown): SafePublicDownloadError {
  if (error instanceof SafePublicDownloadError) return error
  if (error instanceof SafeImageDownloadError) {
    if (error.code === 'UNSAFE_IMAGE_URL') {
      return new SafePublicDownloadError('UNSAFE_RESOURCE_URL', '资源 URL 指向本机或内部网络', false)
    }
    return new SafePublicDownloadError('RESOURCE_DOWNLOAD_FAILED', '无法解析资源下载地址', error.retryable)
  }
  return new SafePublicDownloadError('RESOURCE_DOWNLOAD_FAILED', '资源下载失败', true)
}

function validatePublicResourceUrl(url: URL, httpsOnly: boolean): void {
  if ((httpsOnly && url.protocol !== 'https:')
    || (!httpsOnly && url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new SafePublicDownloadError('UNSAFE_RESOURCE_URL', '资源 URL 协议不受支持', false)
  }
  if (url.username || url.password) {
    throw new SafePublicDownloadError('UNSAFE_RESOURCE_URL', '资源 URL 不能包含凭据', false)
  }
}

async function readLimitedPublicBody(
  response: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.destroy()
    throw new SafePublicDownloadError('RESOURCE_TOO_LARGE', '资源超过大小限制', false)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      response.destroy()
      throw new SafePublicDownloadError('RESOURCE_TOO_LARGE', '资源超过大小限制', false)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}

async function requestPublicResourcePinned(
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
  options: { maxBytes: number; accept: string; userAgent: string },
): Promise<PublicPinnedResponse> {
  return new Promise<PublicPinnedResponse>((resolve, reject) => {
    const originalHostname = stripIpv6Brackets(url.hostname)
    const requestOptions = {
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        accept: options.accept,
        host: url.host,
        'user-agent': options.userAgent,
      },
      signal,
    }
    const onResponse = (response: IncomingMessage) => {
      const status = response.statusCode ?? 0
      if (REDIRECT_STATUSES.has(status)) {
        const location = response.headers.location
        response.resume()
        if (!location) {
          reject(new SafePublicDownloadError(
            'RESOURCE_DOWNLOAD_FAILED',
            '资源下载重定向缺少地址',
            true,
          ))
          return
        }
        resolve({ kind: 'redirect', location })
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new SafePublicDownloadError(
          'RESOURCE_DOWNLOAD_FAILED',
          `资源下载失败 (${status})`,
          status === 408 || status === 429 || status >= 500,
        ))
        return
      }
      void readLimitedPublicBody(response, options.maxBytes).then((bytes) => {
        const rawType = response.headers['content-type']
        const contentType = Array.isArray(rawType) ? rawType[0] ?? null : rawType ?? null
        resolve({ kind: 'resource', resource: { bytes, contentType } })
      }, reject)
    }
    const request = url.protocol === 'https:'
      ? httpsRequest({
          ...requestOptions,
          ...(isIP(originalHostname) ? {} : { servername: originalHostname }),
        }, onResponse)
      : httpRequest(requestOptions, onResponse)
    request.setTimeout(SOCKET_TIMEOUT_MS, () => {
      request.destroy(new SafePublicDownloadError(
        'RESOURCE_DOWNLOAD_FAILED',
        '资源下载连接超时',
        true,
      ))
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * SSRF-safe bounded download for provider-owned JSON/audio/video sidecars.
 * DNS is resolved once per hop and the socket is pinned to the validated IP;
 * every redirect is independently revalidated before another request occurs.
 */
export async function downloadPublicResource(
  urlValue: string,
  signal: AbortSignal,
  options: {
    maxBytes: number
    accept?: string
    userAgent?: string
    httpsOnly?: boolean
  },
  dependencies: PublicDownloadDependencies = {
    lookup: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
    request: requestPublicResourcePinned,
  },
): Promise<DownloadedPublicResource> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error('maxBytes 必须为正整数')
  }
  let current: URL
  try {
    current = new URL(urlValue)
  } catch {
    throw new SafePublicDownloadError('INVALID_RESOURCE_URL', 'Provider 返回了无效资源 URL', true)
  }
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    validatePublicResourceUrl(current, options.httpsOnly !== false)
    let addresses: ResolvedAddress[]
    try {
      addresses = await resolvePublicAddresses(current.hostname, signal, dependencies.lookup)
    } catch (error) {
      throw publicResourceError(error)
    }
    let result: PublicPinnedResponse
    try {
      result = await dependencies.request(current, addresses[0], signal, {
        maxBytes: options.maxBytes,
        accept: options.accept ?? '*/*',
        userAgent: options.userAgent ?? 'manju-studio-provider-resource-fetcher/0.1',
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw publicResourceError(error)
    }
    if (result.kind === 'resource') return result.resource
    if (redirects === MAX_REDIRECTS) {
      throw new SafePublicDownloadError(
        'RESOURCE_DOWNLOAD_FAILED',
        '资源下载重定向次数过多',
        true,
      )
    }
    try {
      current = new URL(result.location, current)
    } catch {
      throw new SafePublicDownloadError('INVALID_RESOURCE_URL', '资源重定向 URL 无效', true)
    }
  }
  throw new SafePublicDownloadError('RESOURCE_DOWNLOAD_FAILED', '资源下载失败', true)
}
