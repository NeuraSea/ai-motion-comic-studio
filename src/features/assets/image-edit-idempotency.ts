const STORAGE_PREFIX = 'manju.asset-image-edit.idempotency.v1.'

interface StoredLease {
  version: 1
  generation: number
  state: 'pending' | 'acknowledged'
  updatedAt: string
}

export interface AssetImageEditIdempotencyLease {
  fingerprint: string
  generation: number
  key: string
}

type LeaseStorage = Pick<Storage, 'getItem' | 'setItem'>

function validStoredLease(value: unknown): value is StoredLease {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as StoredLease).version === 1
    && Number.isInteger((value as StoredLease).generation)
    && (value as StoredLease).generation >= 1
    && ((value as StoredLease).state === 'pending' || (value as StoredLease).state === 'acknowledged')
    && typeof (value as StoredLease).updatedAt === 'string'
}

function readLease(storage: LeaseStorage | undefined, fingerprint: string): StoredLease | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(`${STORAGE_PREFIX}${fingerprint}`)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return validStoredLease(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeLease(
  storage: LeaseStorage | undefined,
  fingerprint: string,
  lease: StoredLease,
): void {
  if (!storage) return
  try {
    storage.setItem(`${STORAGE_PREFIX}${fingerprint}`, JSON.stringify(lease))
  } catch {
    // The deterministic generation-1 key remains safe when storage is denied:
    // a reload can replay an accepted request, but cannot create a duplicate.
  }
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器缺少安全摘要能力，禁止创建可能重复计费的图片任务')
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A pending exact intent always receives the same key across refreshes and
 * tabs. Only an acknowledged prior attempt advances the generation, allowing
 * a deliberate second stochastic variation without weakening unknown-result
 * replay safety. Storage contains only a SHA-256 fingerprint, never prompts.
 */
export async function acquireAssetImageEditIdempotencyLease(
  canonicalIntent: string,
  storage: LeaseStorage | undefined = globalThis.localStorage,
): Promise<AssetImageEditIdempotencyLease> {
  const fingerprint = await sha256(canonicalIntent)
  const current = readLease(storage, fingerprint)
  const generation = current?.state === 'pending'
    ? current.generation
    : (current?.generation ?? 0) + 1
  writeLease(storage, fingerprint, {
    version: 1,
    generation,
    state: 'pending',
    updatedAt: new Date().toISOString(),
  })
  return {
    fingerprint,
    generation,
    key: `asset-image-edit-v1-${fingerprint}-${generation}`,
  }
}

export function acknowledgeAssetImageEditIdempotencyLease(
  lease: AssetImageEditIdempotencyLease,
  storage: LeaseStorage | undefined = globalThis.localStorage,
): void {
  const current = readLease(storage, lease.fingerprint)
  if (!current || current.generation !== lease.generation) return
  writeLease(storage, lease.fingerprint, {
    ...current,
    state: 'acknowledged',
    updatedAt: new Date().toISOString(),
  })
}
