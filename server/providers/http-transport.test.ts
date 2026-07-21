import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import {
  BoundedResponseError,
  ProviderRequestTimeoutError,
  readBoundedResponseJson,
  readBoundedResponseText,
  runWithProviderRequestTimeout,
  safeUpstreamErrorProjection,
} from './http-transport.js'

const encoder = new TextEncoder()

test('bounded reader cancels a dishonest chunked response at the real streamed byte limit', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('123'))
      controller.enqueue(encoder.encode('456'))
      controller.enqueue(encoder.encode('must-not-be-read'))
    },
    cancel() {
      cancelled = true
    },
  })
  const response = new Response(body, {
    headers: { 'content-length': '2' },
  })

  await assert.rejects(readBoundedResponseText(response, 5), (error: unknown) => {
    assert.ok(error instanceof BoundedResponseError)
    assert.equal(error.code, 'BODY_TOO_LARGE')
    return true
  })
  assert.equal(cancelled, true)
})

test('bounded JSON reader counts UTF-8 bytes across split chunks and classifies malformed data', async () => {
  const bytes = encoder.encode('{"字":1}')
  const valid = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  }))
  assert.deepEqual(await readBoundedResponseJson(valid, bytes.byteLength), { 字: 1 })

  const invalidUtf8 = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(0xc3, 0x28))
      controller.close()
    },
  }))
  await assert.rejects(readBoundedResponseJson(invalidUtf8, 10), (error: unknown) => {
    assert.ok(error instanceof BoundedResponseError)
    assert.equal(error.code, 'INVALID_UTF8')
    return true
  })

  await assert.rejects(
    readBoundedResponseJson(new Response('{not-json'), 20),
    (error: unknown) => {
      assert.ok(error instanceof BoundedResponseError)
      assert.equal(error.code, 'INVALID_JSON')
      return true
    },
  )
})

test('request deadline aborts a stalled response body and caller cancellation wins', async () => {
  let deadlineSignal: AbortSignal | undefined
  await assert.rejects(runWithProviderRequestTimeout(undefined, 15, async (signal) => {
    deadlineSignal = signal
    return new Promise<never>(() => undefined)
  }), (error: unknown) => {
    assert.ok(error instanceof ProviderRequestTimeoutError)
    return true
  })
  assert.equal(deadlineSignal?.aborted, true)

  const caller = new AbortController()
  const callerReason = new Error('controlled caller cancellation')
  const cancellation = runWithProviderRequestTimeout(caller.signal, 1_000, async () => (
    new Promise<never>(() => undefined)
  ))
  caller.abort(callerReason)
  await assert.rejects(cancellation, (error: unknown) => error === callerReason)
})

test('successful exchanges clear their deadline and safe projection ignores untrusted text', async () => {
  let requestSignal: AbortSignal | undefined
  const result = await runWithProviderRequestTimeout(undefined, 15, async (signal) => {
    requestSignal = signal
    return 'ok'
  })
  assert.equal(result, 'ok')
  await delay(30)
  assert.equal(requestSignal?.aborted, false)

  const projected = safeUpstreamErrorProjection('text', 500)
  assert.equal(projected, '文本 Provider 请求失败 (500)')
})
