import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderConnection } from '../src/lib'
import {
  defaultExecutableProviderForKind,
  isVerifiedSeedanceProvider,
  providerConnectionLabel,
  providerStatusDetail,
  providerUiConnectionState,
  providerVerificationNotice,
  seedanceGenerationBlockReason,
  speechControlPolicy,
} from '../src/features/providers/provider-ui-state'

function provider(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: 'provider-1',
    label: 'Runtime Provider',
    kind: 'image',
    adapter: 'openai-compatible',
    authMode: 'byok',
    baseUrl: 'https://provider.example/v1',
    model: 'image-model-1',
    capabilities: ['generate'],
    configurableBaseUrl: true,
    enabled: true,
    configRevision: 1,
    isDefault: true,
    credentialState: 'present',
    health: { status: 'untested', message: '' },
    ...overrides,
  }
}

test('saved credentials remain unverified until health is explicitly ok', () => {
  assert.equal(providerUiConnectionState(provider()), 'untested')
  assert.equal(providerUiConnectionState(provider({ health: { status: 'ok', message: '连接成功' } })), 'connected')
  assert.equal(providerUiConnectionState(provider({ health: { status: 'degraded', message: '受限' } })), 'degraded')
  assert.equal(providerUiConnectionState(provider({ health: { status: 'unavailable', message: '异常' } })), 'unavailable')
  assert.equal(providerUiConnectionState(provider({ enabled: false })), 'disabled')
  assert.equal(providerUiConnectionState(provider({ credentialState: 'missing' })), 'unconfigured')
  assert.equal(providerStatusDetail(provider({
    health: { status: 'unavailable', message: 'Authorization: test-secret-value' },
  })).includes('test-secret-value'), false)
})

test('default execution summary uses the actual executable default provider', () => {
  const nonDefault = provider({ id: 'image-backup', label: 'Backup', isDefault: false })
  const selected = provider({ id: 'image-current', label: 'Current', model: 'current-model' })

  assert.equal(defaultExecutableProviderForKind([nonDefault, selected], 'image'), selected)
  assert.equal(defaultExecutableProviderForKind([
    nonDefault,
    provider({ id: 'image-current', isDefault: true, model: '' }),
  ], 'image'), null)
})

test('Seedance requires enabled credential, model, and a successful current health test', () => {
  const seedance = provider({
    id: 'seedance-video',
    label: 'Seedance 2.0',
    kind: 'video',
    adapter: 'seedance',
    model: 'doubao-seedance-2-0-260128',
    capabilities: ['text-to-video'],
  })

  assert.equal(isVerifiedSeedanceProvider(seedance), false)
  assert.match(seedanceGenerationBlockReason(seedance) ?? '', /尚未验证/)
  assert.equal(isVerifiedSeedanceProvider(provider({
    ...seedance,
    health: { status: 'ok', message: '连接成功' },
  })), true)
  assert.equal(isVerifiedSeedanceProvider(provider({
    ...seedance,
    health: { status: 'ok', message: '连接成功' },
    enabled: false,
  })), false)
  assert.equal(isVerifiedSeedanceProvider(provider({
    ...seedance,
    health: { status: 'ok', message: '连接成功' },
    credentialState: 'missing',
  })), false)
  assert.equal(isVerifiedSeedanceProvider(provider({
    ...seedance,
    health: { status: 'ok', message: '连接成功' },
    model: '',
  })), false)
  assert.equal(isVerifiedSeedanceProvider(provider({
    ...seedance,
    health: { status: 'ok', message: '连接成功' },
    baseUrl: '',
  })), false)
})

test('Agent Plan success is labeled as a read-only list probe, not proven billing readiness', () => {
  const agentPlan = provider({
    id: 'seedance-video',
    kind: 'video',
    adapter: 'seedance',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    model: 'doubao-seedance-2.0',
    capabilities: ['text-to-video'],
    health: { status: 'ok', message: '连接成功' },
  })
  assert.equal(providerConnectionLabel(agentPlan), '列表可用')
  assert.match(providerVerificationNotice(agentPlan) ?? '', /不能证明套餐创建额度/)

  const metered = provider({
    ...agentPlan,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  })
  assert.equal(providerConnectionLabel(metered), '路由可用')
  assert.match(providerVerificationNotice(metered) ?? '', /不能证明账号余额/)
  assert.equal(providerConnectionLabel(provider({ health: { status: 'ok', message: '连接成功' } })), null)
})

test('OpenAI-compatible speech never exposes MiniMax-only controls or timestamp promises', () => {
  const custom = provider({
    id: 'custom-speech',
    kind: 'speech',
    adapter: 'openai-compatible',
    capabilities: ['speech'],
  })
  const minimax = provider({
    id: 'minimax-speech',
    kind: 'speech',
    adapter: 'minimax',
    capabilities: ['speech', 'word-timestamps'],
  })

  assert.deepEqual(speechControlPolicy(custom), {
    supportsEmotion: false,
    supportsVolume: false,
    supportsWordTimestamps: false,
    voiceLabel: 'Voice',
  })
  assert.deepEqual(speechControlPolicy(minimax), {
    supportsEmotion: true,
    supportsVolume: true,
    supportsWordTimestamps: true,
    voiceLabel: 'MiniMax voice_id',
  })
})
