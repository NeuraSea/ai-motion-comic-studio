import assert from 'node:assert/strict'
import test from 'node:test'

import {
  characterVoiceCatalogFingerprint,
  characterVoiceRecommendationShortlist,
  CharacterVoiceRecommendationError,
  recommendCharacterVoice,
  type CharacterVoiceRecommendationInput,
} from './character-voice-recommendation.js'
import type { StructuredGenerationInput, TextProvider } from './providers/text.js'

function input(): CharacterVoiceRecommendationInput {
  return {
    character: {
      id: 'ali',
      name: '阿离',
      role: '年轻剑客',
      storyDescription: '外冷内热，背负秘密，遇到危险时果断。',
      visualDescription: '二十岁左右，红绳束发。',
    },
    scenes: [{
      sceneId: 'cliff',
      title: '秦岭断崖',
      timeOfDay: '暮色',
      description: '群山震颤，远处传来龙吟。',
      lines: [{ kind: 'dialogue', text: '它醒了。' }],
    }],
    voices: [
      {
        voiceId: 'Chinese (Mandarin)_Calm_Young_Woman',
        voiceName: '沉静少女',
        descriptions: ['冷静、清晰的年轻女性普通话音色。'],
        type: 'system',
      },
      {
        voiceId: 'Chinese (Mandarin)_Heroic_Young_Woman',
        voiceName: '英气少女',
        descriptions: ['坚定、有力量的年轻女性音色。'],
        type: 'system',
      },
      {
        voiceId: 'account-cloned-voice',
        voiceName: null,
        descriptions: [],
        type: 'voice_cloning',
      },
    ],
    idempotencyKey: 'voice-recommendation-job-1',
  }
}

class StubTextProvider implements TextProvider {
  readonly name = 'stub-text'
  readonly model = 'stub-structured'
  readonly configured = true
  request: StructuredGenerationInput | null = null

  async listModels(): Promise<string[]> { return [this.model] }

  async generateStructured<T>(
    request: StructuredGenerationInput,
    validate: (value: unknown) => T,
  ): Promise<T> {
    this.request = request
    return validate({
      selectedVoiceId: 'Chinese (Mandarin)_Heroic_Young_Woman',
      rationale: '英气但不过分成熟，适合年轻剑客的克制与果断。',
      profileTags: ['年轻', '克制', '英气'],
      alternatives: [{
        voiceId: 'Chinese (Mandarin)_Calm_Young_Woman',
        rationale: '更偏安静内敛。',
      }],
      defaultDelivery: { emotion: 'calm', speed: 0.95, pitch: 0 },
      sceneDirections: [{
        sceneId: 'cliff',
        emotion: 'whisper',
        speed: 0.82,
        pitch: -1,
        rationale: '压低声音表现震惊与警觉。',
      }],
    })
  }
}

test('casting agent chooses only real account voices and keeps per-scene delivery separate', async () => {
  const provider = new StubTextProvider()
  const result = await recommendCharacterVoice(provider, input(), new AbortController().signal)

  assert.equal(result.selectedVoiceId, 'Chinese (Mandarin)_Heroic_Young_Woman')
  assert.equal(result.alternatives[0].voiceId, 'Chinese (Mandarin)_Calm_Young_Woman')
  assert.equal(result.sceneDirections[0].sceneId, 'cliff')
  assert.equal(result.sceneDirections[0].emotion, 'whisper')
  assert.match(result.catalogFingerprint, /^[0-9a-f]{64}$/)
  assert.equal(provider.request?.idempotencyKey, 'voice-recommendation-job-1')
  assert.match(provider.request?.systemPrompt ?? '', /不要按场景更换角色音色/)
  assert.match(provider.request?.userPrompt ?? '', /account-cloned-voice/)
  assert.equal((provider.request?.userPrompt ?? '').includes('API Key'), false)
  assert.equal(JSON.stringify(provider.request?.schema).includes('uniqueItems'), false)
})

test('casting agent rejects a hallucinated voice or scene before it can be persisted', async () => {
  class InvalidProvider extends StubTextProvider {
    override async generateStructured<T>(
      _request: StructuredGenerationInput,
      validate: (value: unknown) => T,
    ): Promise<T> {
      return validate({
        selectedVoiceId: 'invented-voice',
        rationale: '不存在的音色',
        profileTags: ['虚构'],
        alternatives: [],
        defaultDelivery: { emotion: 'calm', speed: 1, pitch: 0 },
        sceneDirections: [{
          sceneId: 'invented-scene',
          emotion: 'calm',
          speed: 1,
          pitch: 0,
          rationale: '未知场景',
        }],
      })
    }
  }

  await assert.rejects(
    recommendCharacterVoice(new InvalidProvider(), input(), new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof CharacterVoiceRecommendationError)
      assert.equal(error.code, 'VOICE_RECOMMENDATION_OUTPUT_INVALID')
      assert.match(error.message, /当前账号音色目录/)
      return true
    },
  )
})

test('casting agent rejects fractional pitch before a recommendation can be persisted', async () => {
  class FractionalPitchProvider extends StubTextProvider {
    override async generateStructured<T>(
      _request: StructuredGenerationInput,
      validate: (value: unknown) => T,
    ): Promise<T> {
      return validate({
        selectedVoiceId: 'Chinese (Mandarin)_Heroic_Young_Woman',
        rationale: '音色本身存在，但 pitch 使用了 Provider 不接受的小数。',
        profileTags: ['年轻'],
        alternatives: [],
        defaultDelivery: { emotion: 'calm', speed: 1, pitch: 0.05 },
        sceneDirections: [],
      })
    }
  }

  await assert.rejects(
    recommendCharacterVoice(new FractionalPitchProvider(), input(), new AbortController().signal),
    (error: unknown) => error instanceof CharacterVoiceRecommendationError
      && error.code === 'VOICE_RECOMMENDATION_OUTPUT_INVALID'
      && /pitch/.test(error.message),
  )
})

test('casting agent fails closed for an empty or oversized/ambiguous catalog context', async () => {
  const provider = new StubTextProvider()
  await assert.rejects(
    recommendCharacterVoice(provider, { ...input(), voices: [] }, new AbortController().signal),
    (error: unknown) => error instanceof CharacterVoiceRecommendationError
      && error.code === 'VOICE_CATALOG_EMPTY',
  )
  await assert.rejects(
    recommendCharacterVoice(provider, {
      ...input(),
      scenes: [input().scenes[0], input().scenes[0]],
    }, new AbortController().signal),
    (error: unknown) => error instanceof CharacterVoiceRecommendationError
      && error.code === 'VOICE_RECOMMENDATION_INPUT_INVALID',
  )
  await assert.rejects(
    recommendCharacterVoice(provider, {
      ...input(),
      catalogFingerprint: 'invalid',
    }, new AbortController().signal),
    (error: unknown) => error instanceof CharacterVoiceRecommendationError
      && error.code === 'VOICE_RECOMMENDATION_INPUT_INVALID'
      && /fingerprint/.test(error.message),
  )
  await assert.rejects(
    recommendCharacterVoice(provider, {
      ...input(),
      candidateFingerprint: 'f'.repeat(64),
    }, new AbortController().signal),
    (error: unknown) => error instanceof CharacterVoiceRecommendationError
      && error.code === 'VOICE_RECOMMENDATION_INPUT_INVALID'
      && /fingerprint/.test(error.message),
  )
})

test('catalog fingerprint is reorder-stable and a >400 directory keeps account voices in a bounded shortlist', async () => {
  const systemVoices = Array.from({ length: 450 }, (_, index) => ({
    voiceId: `system-${String(index).padStart(3, '0')}`,
    voiceName: `System ${index}`,
    descriptions: ['second', 'first'],
    type: 'system' as const,
  }))
  const accountVoice = {
    voiceId: 'account-cloned-last-upstream',
    voiceName: 'Account clone',
    descriptions: ['owned voice'],
    type: 'voice_cloning' as const,
  }
  const fullCatalog = [...systemVoices, accountVoice]
  const reordered = [
    { ...accountVoice, descriptions: [...accountVoice.descriptions].reverse() },
    ...[...systemVoices].reverse().map((voice) => ({
      ...voice,
      descriptions: [...voice.descriptions].reverse(),
    })),
  ]
  const fullFingerprint = characterVoiceCatalogFingerprint(fullCatalog)
  assert.equal(characterVoiceCatalogFingerprint(reordered), fullFingerprint)

  const shortlist = characterVoiceRecommendationShortlist(fullCatalog)
  assert.equal(shortlist.length, 400)
  assert.equal(shortlist[0].voiceId, accountVoice.voiceId)

  class AccountVoiceProvider extends StubTextProvider {
    override async generateStructured<T>(
      request: StructuredGenerationInput,
      validate: (value: unknown) => T,
    ): Promise<T> {
      this.request = request
      return validate({
        selectedVoiceId: accountVoice.voiceId,
        rationale: '优先使用账号自有克隆音色。',
        profileTags: ['账号自有'],
        alternatives: [],
        defaultDelivery: { emotion: 'calm', speed: 1, pitch: 0 },
        sceneDirections: [],
      })
    }
  }
  const result = await recommendCharacterVoice(new AccountVoiceProvider(), {
    ...input(),
    voices: shortlist,
    catalogFingerprint: fullFingerprint,
    candidateFingerprint: characterVoiceCatalogFingerprint(shortlist),
  }, new AbortController().signal)
  assert.equal(result.catalogFingerprint, fullFingerprint)
  assert.equal(result.selectedVoiceId, accountVoice.voiceId)
})
