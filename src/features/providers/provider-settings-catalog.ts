export type ProviderCategory = 'text' | 'image' | 'video' | 'speech'

export type ProviderAuthMode = 'byoa' | 'byok'

export interface ProviderCatalogItem {
  id: string
  category: ProviderCategory
  name: string
  description: string
  authMode: ProviderAuthMode
  badge?: string
  defaultBaseUrl?: string
  defaultModel?: string
  editableBaseUrl?: boolean
  editableModel?: boolean
  baseUrlPresets?: readonly {
    label: string
    value: string
  }[]
  modelOptions?: readonly string[]
  configurationModes?: readonly {
    id: string
    label: string
    description: string
    baseUrl?: string
    defaultModel?: string
    modelOptions?: readonly string[]
    editableBaseUrl?: boolean
    editableModel?: boolean
  }[]
  baseUrlHelp?: string
  modelHelp?: string
}

export const MINIMAX_BASE_URL_PRESETS = [
  { label: '海外版 · api.minimax.io', value: 'https://api.minimax.io' },
  { label: '国内版 · api.minimaxi.com', value: 'https://api.minimaxi.com' },
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

export const SEEDANCE_AGENT_PLAN_MODELS = [
  'doubao-seedance-2.0',
  'doubao-seedance-2.0-fast',
  'doubao-seedance-2.0-mini',
] as const

export const SEEDANCE_CONFIGURATION_MODES = [
  {
    id: 'agent-plan',
    label: 'Agent Plan（推荐）',
    description: '使用方舟 Agent Plan 专属 API Key 与套餐路由；连接测试只读取任务列表，不创建计费任务。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    defaultModel: 'doubao-seedance-2.0',
    modelOptions: SEEDANCE_AGENT_PLAN_MODELS,
  },
  {
    id: 'metered',
    label: '方舟按量计费',
    description: '使用方舟标准 /api/v3 路由；模型 ID 由方舟控制台或当前接入点决定。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seedance-2-0-260128',
    editableModel: true,
  },
  {
    id: 'custom',
    label: '自定义兼容网关',
    description: '连接实现 Seedance 任务协议的 HTTPS 网关；Base URL 与模型均由你配置。',
    editableBaseUrl: true,
    editableModel: true,
  },
] as const

function normalizedBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function catalogAllowsBaseUrl(provider: ProviderCatalogItem, value: string): boolean {
  return !provider.baseUrlPresets
    || provider.baseUrlPresets.some((preset) => (
      normalizedBaseUrl(preset.value) === normalizedBaseUrl(value)
    ))
}

export function catalogAllowsModel(provider: ProviderCatalogItem, value: string): boolean {
  return !provider.modelOptions || provider.modelOptions.includes(value.trim())
}

/**
 * Canonical MVP catalog: two text, two image, one video, and two speech cards.
 * Runtime connection state is intentionally supplied separately by the API.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogItem[] = [
  {
    id: 'codex-tools-text',
    category: 'text',
    name: 'Codex Tools',
    description: '使用本机 Codex Tools 账号授权生成结构化剧本。',
    authMode: 'byoa',
    badge: '默认',
    defaultBaseUrl: 'http://127.0.0.1:8787/v1',
    defaultModel: 'gpt-5.5',
  },
  {
    id: 'custom-text',
    category: 'text',
    name: '自定义文本',
    description: '连接 OpenAI-compatible Text API。',
    authMode: 'byok',
    badge: '自定义',
    editableBaseUrl: true,
    editableModel: true,
  },
  {
    id: 'codex-tools-image',
    category: 'image',
    name: 'Codex Tools Image',
    description: '使用本机 Codex Tools 账号授权生成和编辑图片。',
    authMode: 'byoa',
    badge: '默认',
    defaultBaseUrl: 'http://127.0.0.1:8787/v1',
    defaultModel: 'gpt-image-2',
  },
  {
    id: 'custom-image',
    category: 'image',
    name: '自定义图片',
    description: '连接 OpenAI-compatible Images API。',
    authMode: 'byok',
    badge: '自定义',
    editableBaseUrl: true,
    editableModel: true,
  },
  {
    id: 'seedance-video',
    category: 'video',
    name: 'Seedance 2.0',
    description: '支持火山方舟官方地址（Agent Plan / 按量计费）或兼容 NewAPI 网关；密钥不会写入项目，只进入 macOS 钥匙串。',
    authMode: 'byok',
    badge: '逐镜视频',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    defaultModel: 'doubao-seedance-2.0',
    editableBaseUrl: true,
    editableModel: true,
    configurationModes: SEEDANCE_CONFIGURATION_MODES,
    baseUrlHelp: 'Agent Plan 与按量计费使用不同路由；切换接入方式会自动填入正确地址。',
    modelHelp: 'Agent Plan 模型不参与 Auto 或 /models 探测，必须从套餐支持列表中明确选择。',
  },
  {
    id: 'doubao-speech',
    category: 'speech',
    name: '豆包语音 2.0',
    description: '方舟 Agent Plan 专属 TTS，支持官方声线、情绪、语速、音量与音高。',
    authMode: 'byok',
    badge: 'Agent Plan',
    defaultBaseUrl: 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional',
    defaultModel: 'doubao-seed-tts-2.0',
    editableBaseUrl: false,
    editableModel: false,
    baseUrlHelp: '官方 HTTP 单向接口；Resource-Id 固定为 seed-tts-2.0。',
    modelHelp: '请输入方舟 Agent Plan 页面获取的专属 API Key，不是旧版语音 App ID/Access Token。',
  },
  {
    id: 'minimax-speech',
    category: 'speech',
    name: 'MiniMax',
    description: '海外/国内官方 TTS，支持词级字幕时码。',
    authMode: 'byok',
    badge: '默认',
    defaultBaseUrl: 'https://api.minimax.io',
    defaultModel: 'speech-2.8-hd',
    editableBaseUrl: true,
    editableModel: true,
    baseUrlPresets: MINIMAX_BASE_URL_PRESETS,
    modelOptions: MINIMAX_SPEECH_MODELS,
  },
  {
    id: 'indextts-speech',
    category: 'speech',
    name: 'IndexTTS2',
    description: '连接自托管 Sidecar，继承参考声线并支持情绪控制；推理数据不离开你的服务。',
    authMode: 'byok',
    badge: '本地 / 自托管',
    defaultBaseUrl: 'http://127.0.0.1:7861',
    defaultModel: 'IndexTTS-2',
    editableBaseUrl: true,
    editableModel: true,
  },
  {
    id: 'custom-speech',
    category: 'speech',
    name: '自定义语音',
    description: '连接 OpenAI-compatible Speech API；仅承诺 voice、speed 与音频格式。',
    authMode: 'byok',
    badge: '自定义',
    editableBaseUrl: true,
    editableModel: true,
  },
] as const
