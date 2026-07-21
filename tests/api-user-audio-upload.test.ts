import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiError, uploadUserAudio } from '../src/lib/api'

const NOW = '2026-07-14T00:00:00.000Z'

function uploadedAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audio-asset-1',
    projectId: 'project/one',
    episodeId: 'episode & 2',
    kind: 'bgm',
    version: 1,
    status: 'ready',
    mimeType: 'audio/wav',
    width: null,
    height: null,
    durationSeconds: 12.5,
    checksum: 'a'.repeat(64),
    source: 'upload',
    providerId: null,
    generationJobId: null,
    sourceRevisionId: null,
    parentAssetId: null,
    originalFileName: '主题 & 夜雨.wav',
    url: '/api/v1/assets/audio-asset-1/content',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

test('audio upload client sends raw bytes with encoded ownership and canonical MIME', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  const file = new File([new Uint8Array([1, 2, 3, 4])], '主题 & 夜雨.wav', {
    type: 'audio/x-wav',
  })
  let captured: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (input, init = {}) => {
    captured = { url: String(input), init }
    return new Response(JSON.stringify({ asset: uploadedAsset() }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const asset = await uploadUserAudio(
      'project/one',
      'episode & 2',
      'bgm',
      file,
      { signal: controller.signal },
    )

    assert.equal(asset.id, 'audio-asset-1')
    assert.equal(asset.durationSeconds, 12.5)
    assert.equal(
      captured?.url,
      '/api/v1/assets/uploads/audio?projectId=project%2Fone&episodeId=episode+%26+2&kind=bgm&name=%E4%B8%BB%E9%A2%98+%26+%E5%A4%9C%E9%9B%A8.wav',
    )
    assert.equal(captured?.init.method, 'POST')
    assert.equal(new Headers(captured?.init.headers).get('Content-Type'), 'audio/wav')
    assert.equal(captured?.init.body, file)
    assert.equal(captured?.init.signal, controller.signal)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('audio upload client rejects unsupported MIME before making a request', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    throw new Error('fetch must not be called')
  }) as typeof fetch

  try {
    await assert.rejects(
      uploadUserAudio(
        'project/one',
        'episode & 2',
        'sfx',
        new Blob([new Uint8Array([1])], { type: 'audio/ogg' }),
      ),
      (error: unknown) => error instanceof ApiError
        && error.code === 'UNSUPPORTED_AUDIO_TYPE',
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('audio upload client rejects mismatched ownership and malformed upload assets', async () => {
  const originalFetch = globalThis.fetch
  const invalidAssets = [
    uploadedAsset({ projectId: 'other-project' }),
    uploadedAsset({ episodeId: 'other-episode' }),
    uploadedAsset({ kind: 'sfx' }),
    uploadedAsset({ mimeType: 'audio/mpeg' }),
    uploadedAsset({ durationSeconds: 0 }),
    uploadedAsset({ source: 'provider' }),
    uploadedAsset({ providerId: 'some-provider' }),
    uploadedAsset({ url: 'https://example.invalid/audio.wav' }),
  ]
  globalThis.fetch = (async () => new Response(JSON.stringify({
    asset: invalidAssets.shift(),
  }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch

  try {
    for (let index = 0; index < 8; index += 1) {
      await assert.rejects(
        uploadUserAudio(
          'project/one',
          'episode & 2',
          'bgm',
          new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
          { name: '主题 & 夜雨.wav' },
        ),
        (error: unknown) => error instanceof ApiError
          && error.code === 'INVALID_RESPONSE',
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('audio upload client maps an aborted fetch to REQUEST_ABORTED', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = (async () => {
    throw new DOMException('The operation was aborted', 'AbortError')
  }) as typeof fetch

  try {
    await assert.rejects(
      uploadUserAudio(
        'project/one',
        'episode & 2',
        'sfx',
        new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }),
        { signal: controller.signal },
      ),
      (error: unknown) => error instanceof ApiError
        && error.code === 'REQUEST_ABORTED',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
