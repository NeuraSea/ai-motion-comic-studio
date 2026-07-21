import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  acknowledgeAssetImageEditIdempotencyLease,
  acquireAssetImageEditIdempotencyLease,
} from '../src/features/assets/image-edit-idempotency'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  dump(): string[] {
    return [...this.values.values()]
  }
}

test('unknown image edit outcome reuses one opaque key across refreshes without storing the prompt', async () => {
  const storage = new MemoryStorage()
  const intent = JSON.stringify({ prompt: 'private character edit', sourceAssetId: 'asset-1' })
  const first = await acquireAssetImageEditIdempotencyLease(intent, storage)
  const replay = await acquireAssetImageEditIdempotencyLease(intent, storage)

  assert.equal(replay.key, first.key)
  assert.equal(replay.generation, 1)
  assert.ok(storage.dump().every((value) => !value.includes('private character edit')))
})

test('only an acknowledged edit advances the deterministic attempt generation', async () => {
  const storage = new MemoryStorage()
  const first = await acquireAssetImageEditIdempotencyLease('same variation intent', storage)
  acknowledgeAssetImageEditIdempotencyLease(first, storage)
  const deliberateSecondAttempt = await acquireAssetImageEditIdempotencyLease('same variation intent', storage)

  assert.equal(deliberateSecondAttempt.generation, 2)
  assert.notEqual(deliberateSecondAttempt.key, first.key)
  assert.equal(
    (await acquireAssetImageEditIdempotencyLease('same variation intent', storage)).key,
    deliberateSecondAttempt.key,
  )
})
