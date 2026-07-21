export type ProviderKind = 'text' | 'image' | 'video' | 'speech'
export type ProviderAuthMode = 'byoa' | 'byok'
export type ProviderHealthState = 'untested' | 'ok' | 'degraded' | 'unavailable'

export interface ProviderDefinition {
  id: string
  label: string
  kind: ProviderKind
  adapter: 'codex-tools' | 'openai-compatible' | 'seedance' | 'minimax' | 'indextts' | 'doubao-speech'
  authMode: ProviderAuthMode
  defaultBaseUrl: string
  defaultModel: string
  capabilities: string[]
  configurableBaseUrl: boolean
  /** Exact regional endpoints for a registered Provider; never arbitrary hosts. */
  allowedBaseUrls?: readonly string[]
  /** Optional exact model allow-list for a registered, non-generic adapter. */
  allowedModels?: readonly string[]
}

export const MINIMAX_OFFICIAL_BASE_URLS = [
  'https://api.minimax.io',
  'https://api.minimaxi.com',
] as const

export const MINIMAX_SPEECH_MODELS = [
  'speech-2.8-hd',
  'speech-2.8-turbo',
  'speech-2.6-hd',
  'speech-2.6-turbo',
  'speech-02-hd',
  'speech-02-turbo',
  'speech-01-hd',
  'speech-01-turbo',
] as const

export const SEEDANCE_AGENT_PLAN_BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3'
export const SEEDANCE_METERED_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
export const SEEDANCE_AGENT_PLAN_MODELS = [
  'doubao-seedance-2.0',
  'doubao-seedance-2.0-fast',
  'doubao-seedance-2.0-mini',
] as const

export const DOUBAO_SPEECH_BASE_URL = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional'
export const DOUBAO_SPEECH_MODEL = 'doubao-seed-tts-2.0'

export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  {
    id: 'codex-tools-text',
    label: 'Codex Tools 文本',
    kind: 'text',
    adapter: 'codex-tools',
    authMode: 'byoa',
    defaultBaseUrl: 'http://127.0.0.1:8787',
    defaultModel: 'gpt-5.5',
    capabilities: ['structured-output', 'json-schema', 'vision'],
    configurableBaseUrl: false,
  },
  {
    id: 'custom-text',
    label: '自定义文本 Provider',
    kind: 'text',
    adapter: 'openai-compatible',
    authMode: 'byok',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    capabilities: ['structured-output', 'vision'],
    configurableBaseUrl: true,
  },
  {
    id: 'codex-tools-image',
    label: 'Codex Tools 图片',
    kind: 'image',
    adapter: 'codex-tools',
    authMode: 'byoa',
    defaultBaseUrl: 'http://127.0.0.1:8787',
    defaultModel: 'gpt-image-2',
    capabilities: ['generate', 'edit', 'variations', 'multi-reference'],
    configurableBaseUrl: false,
  },
  {
    id: 'custom-image',
    label: '自定义图片 Provider',
    kind: 'image',
    adapter: 'openai-compatible',
    authMode: 'byok',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    capabilities: ['generate'],
    configurableBaseUrl: true,
  },
  {
    id: 'seedance-video',
    label: 'Seedance 2.0',
    kind: 'video',
    adapter: 'seedance',
    authMode: 'byok',
    defaultBaseUrl: SEEDANCE_AGENT_PLAN_BASE_URL,
    defaultModel: SEEDANCE_AGENT_PLAN_MODELS[0],
    capabilities: ['text-to-video', 'image-to-video', 'first-last-frame', 'multi-reference'],
    configurableBaseUrl: true,
  },
  {
    id: 'doubao-speech',
    label: '豆包语音 2.0',
    kind: 'speech',
    adapter: 'doubao-speech',
    authMode: 'byok',
    defaultBaseUrl: DOUBAO_SPEECH_BASE_URL,
    defaultModel: DOUBAO_SPEECH_MODEL,
    capabilities: ['speech', 'emotion-control', 'official-voice-catalog'],
    configurableBaseUrl: false,
    allowedBaseUrls: [DOUBAO_SPEECH_BASE_URL],
    allowedModels: [DOUBAO_SPEECH_MODEL],
  },
  {
    id: 'minimax-speech',
    label: 'MiniMax 语音',
    kind: 'speech',
    adapter: 'minimax',
    authMode: 'byok',
    defaultBaseUrl: 'https://api.minimax.io',
    defaultModel: 'speech-2.8-hd',
    capabilities: ['speech', 'word-timestamps'],
    configurableBaseUrl: true,
    allowedBaseUrls: MINIMAX_OFFICIAL_BASE_URLS,
    allowedModels: MINIMAX_SPEECH_MODELS,
  },
  {
    id: 'indextts-speech',
    label: 'IndexTTS2 本地语音',
    kind: 'speech',
    adapter: 'indextts',
    authMode: 'byok',
    defaultBaseUrl: 'http://127.0.0.1:7861',
    defaultModel: 'IndexTTS-2',
    capabilities: ['speech', 'voice-cloning', 'emotion-control'],
    configurableBaseUrl: true,
  },
  {
    id: 'custom-speech',
    label: '自定义语音 Provider',
    kind: 'speech',
    adapter: 'openai-compatible',
    authMode: 'byok',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    capabilities: ['speech'],
    configurableBaseUrl: true,
  },
] as const

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_CATALOG.find((provider) => provider.id === id)
}

export function requireProviderDefinition(id: string): ProviderDefinition {
  const provider = getProviderDefinition(id)
  if (!provider) throw new Error(`Unknown provider: ${id}`)
  return provider
}

export function validateProviderBaseUrl(value: string, allowLocalhost = false): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Provider Base URL 格式无效')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Provider Base URL 不能包含凭据、查询参数或锦标')
  }
  const localHostname = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(allowLocalhost && url.protocol === 'http:' && localHostname)) {
    throw new Error('Provider Base URL 必须使用 HTTPS（本机 Provider 除外）')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}
