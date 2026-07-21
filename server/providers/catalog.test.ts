import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MINIMAX_OFFICIAL_BASE_URLS,
  MINIMAX_SPEECH_MODELS,
  DOUBAO_SPEECH_BASE_URL,
  DOUBAO_SPEECH_MODEL,
  SEEDANCE_AGENT_PLAN_BASE_URL,
  SEEDANCE_AGENT_PLAN_MODELS,
  PROVIDER_CATALOG,
  validateProviderBaseUrl,
} from './catalog.js'

test('provider catalog exposes the locked MVP provider matrix without secrets', () => {
  assert.deepEqual(
    PROVIDER_CATALOG.map(({ id, authMode }) => [id, authMode]),
    [
      ['codex-tools-text', 'byoa'],
      ['custom-text', 'byok'],
      ['codex-tools-image', 'byoa'],
      ['custom-image', 'byok'],
      ['seedance-video', 'byok'],
      ['doubao-speech', 'byok'],
      ['minimax-speech', 'byok'],
      ['indextts-speech', 'byok'],
      ['custom-speech', 'byok'],
    ],
  )
  assert.equal(JSON.stringify(PROVIDER_CATALOG).includes('apiKey'), false)
})

test('Seedance accepts an official Ark endpoint or a custom HTTPS gateway', () => {
  const seedance = PROVIDER_CATALOG.find((provider) => provider.id === 'seedance-video')

  assert.ok(seedance)
  assert.equal(seedance.adapter, 'seedance')
  assert.equal(seedance.defaultBaseUrl, SEEDANCE_AGENT_PLAN_BASE_URL)
  assert.equal(seedance.defaultModel, SEEDANCE_AGENT_PLAN_MODELS[0])
  assert.equal(seedance.configurableBaseUrl, true)
})

test('Doubao Speech is a fixed Agent Plan provider with no project-stored secret', () => {
  const doubao = PROVIDER_CATALOG.find((provider) => provider.id === 'doubao-speech')
  assert.ok(doubao)
  assert.equal(doubao.adapter, 'doubao-speech')
  assert.equal(doubao.defaultBaseUrl, DOUBAO_SPEECH_BASE_URL)
  assert.equal(doubao.defaultModel, DOUBAO_SPEECH_MODEL)
  assert.equal(doubao.configurableBaseUrl, false)
  assert.deepEqual(doubao.allowedBaseUrls, [DOUBAO_SPEECH_BASE_URL])
  assert.deepEqual(doubao.allowedModels, [DOUBAO_SPEECH_MODEL])
})

test('MiniMax exposes only the official China and international regional bases', () => {
  const minimax = PROVIDER_CATALOG.find((provider) => provider.id === 'minimax-speech')

  assert.ok(minimax)
  assert.equal(minimax.adapter, 'minimax')
  assert.equal(minimax.defaultBaseUrl, 'https://api.minimax.io')
  assert.equal(minimax.configurableBaseUrl, true)
  assert.deepEqual(minimax.allowedBaseUrls, MINIMAX_OFFICIAL_BASE_URLS)
  assert.deepEqual(minimax.allowedModels, MINIMAX_SPEECH_MODELS)
  assert.deepEqual(MINIMAX_OFFICIAL_BASE_URLS, [
    'https://api.minimax.io',
    'https://api.minimaxi.com',
  ])
  assert.deepEqual(MINIMAX_SPEECH_MODELS, [
    'speech-2.8-hd',
    'speech-2.8-turbo',
    'speech-2.6-hd',
    'speech-2.6-turbo',
    'speech-02-hd',
    'speech-02-turbo',
    'speech-01-hd',
    'speech-01-turbo',
  ])
})

test('provider base URLs require HTTPS except explicit localhost development', () => {
  assert.equal(validateProviderBaseUrl('https://example.com/v1/'), 'https://example.com/v1')
  assert.equal(validateProviderBaseUrl('http://127.0.0.1:8787', true), 'http://127.0.0.1:8787')
  assert.throws(() => validateProviderBaseUrl('http://example.com/v1', true), /HTTPS/)
  assert.throws(() => validateProviderBaseUrl('https://user:pass@example.com/v1'), /凭据/)
  assert.throws(() => validateProviderBaseUrl('file:///tmp/provider'), /HTTPS/)
})
