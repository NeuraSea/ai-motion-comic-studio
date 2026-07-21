import { characterVoiceCatalogFingerprint } from './character-voice-recommendation.js'
import { DOUBAO_SPEECH_2_VOICES } from './doubao-voice-catalog-data.js'
import type { MiniMaxVoiceCatalogEntry } from './minimax-voice-catalog.js'
import {
  ProviderConfigurationError,
  ProviderService,
  type MaterializedProviderExecutionProfile,
} from './providers/service.js'

export interface DoubaoVoiceCatalog {
  providerId: 'doubao-speech'
  providerConfigRevision: number
  model: string
  observedAt: string
  fingerprint: string
  voices: MiniMaxVoiceCatalogEntry[]
}

export class DoubaoVoiceCatalogError extends Error {
  constructor(
    readonly code: 'DOUBAO_VOICE_PROVIDER_INVALID' | 'DOUBAO_VOICE_PROVIDER_NOT_VERIFIED',
    message: string,
  ) {
    super(message)
    this.name = 'DoubaoVoiceCatalogError'
  }
}

function catalog(profile: MaterializedProviderExecutionProfile): DoubaoVoiceCatalog {
  if (profile.providerId !== 'doubao-speech'
    || profile.kind !== 'speech'
    || profile.adapter !== 'doubao-speech'
    || profile.model !== 'doubao-seed-tts-2.0'
    || !profile.apiKey.trim()) {
    throw new DoubaoVoiceCatalogError('DOUBAO_VOICE_PROVIDER_INVALID', '豆包语音 Provider 配置不完整')
  }
  const voices: MiniMaxVoiceCatalogEntry[] = DOUBAO_SPEECH_2_VOICES.map((voice) => ({
    voiceId: voice.voiceId,
    name: voice.name,
    descriptions: [...voice.descriptions],
    type: voice.type,
  }))
  return {
    providerId: 'doubao-speech',
    providerConfigRevision: profile.configRevision,
    model: profile.model,
    observedAt: new Date().toISOString(),
    fingerprint: characterVoiceCatalogFingerprint(voices.map((voice) => ({
      voiceId: voice.voiceId,
      voiceName: voice.name,
      descriptions: voice.descriptions,
      type: voice.type,
    }))),
    voices,
  }
}

export class DoubaoVoiceCatalogService {
  constructor(private readonly providers: ProviderService) {}

  async list(): Promise<DoubaoVoiceCatalog> {
    let profile: MaterializedProviderExecutionProfile
    try {
      profile = await this.providers.materializeCurrentVerifiedProfile('doubao-speech')
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        throw new DoubaoVoiceCatalogError(
          error.code === 'PROVIDER_NOT_VERIFIED'
            ? 'DOUBAO_VOICE_PROVIDER_NOT_VERIFIED'
            : 'DOUBAO_VOICE_PROVIDER_INVALID',
          error.code === 'PROVIDER_NOT_VERIFIED'
            ? '请先保存并测试豆包语音 Provider'
            : '豆包语音 Provider 配置不可用',
        )
      }
      throw error
    }
    return catalog(profile)
  }
}
