import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MINIMAX_BASE_URL_PRESETS,
  MINIMAX_SPEECH_MODELS,
  PROVIDER_CATALOG,
  catalogAllowsBaseUrl,
  catalogAllowsModel,
} from '../src/features/providers/provider-settings-catalog'

test('Seedance settings support official Ark and compatible NewAPI gateway configuration', () => {
  const seedance = PROVIDER_CATALOG.find((provider) => provider.id === 'seedance-video')

  assert.ok(seedance)
  assert.equal(seedance.editableBaseUrl, true)
  assert.equal(seedance.editableModel, true)
  assert.match(seedance.description, /火山方舟官方地址/)
  assert.match(seedance.description, /兼容 NewAPI 网关/)
  assert.match(seedance.description, /密钥不会写入项目/)
  assert.equal(JSON.stringify(seedance).includes('apiKey'), false)
})

test('MiniMax uses explicit domestic/overseas presets and a controlled speech model list', () => {
  const minimax = PROVIDER_CATALOG.find((provider) => provider.id === 'minimax-speech')

  assert.ok(minimax)
  assert.equal(minimax.defaultBaseUrl, 'https://api.minimax.io')
  assert.deepEqual(minimax.baseUrlPresets, MINIMAX_BASE_URL_PRESETS)
  assert.deepEqual(minimax.modelOptions, MINIMAX_SPEECH_MODELS)
  assert.equal(catalogAllowsBaseUrl(minimax, 'https://api.minimax.io/'), true)
  assert.equal(catalogAllowsBaseUrl(minimax, 'https://api.minimaxi.com'), true)
  assert.equal(catalogAllowsBaseUrl(minimax, 'https://untrusted.example'), false)
  assert.equal(catalogAllowsModel(minimax, 'speech-2.8-hd'), true)
  assert.equal(catalogAllowsModel(minimax, 'unregistered-speech-model'), false)
})
