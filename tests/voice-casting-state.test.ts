import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  MiniMaxVoiceCatalogEntry,
  StoryCharacterVoiceProfile,
  StoryDocument,
} from '../src/lib/api-types'
import {
  characterForDialogueLine,
  characterVoiceProfileConfirmationInput,
  dialogueSpeechErrorMessage,
  dialogueVoiceSubmissionPlan,
  filterMiniMaxVoices,
  isVoiceProfileCurrentForCatalog,
  normalizeMiniMaxPitch,
  recommendationCanBeConfirmed,
  resolveCharacterVoiceDelivery,
  voiceProfileForStoryLine,
} from '../src/features/voices/voice-casting-state'

const voices: MiniMaxVoiceCatalogEntry[] = [{
  voiceId: 'cn-heroine',
  name: '英气少女',
  descriptions: ['年轻、坚定的普通话女声'],
  type: 'system',
}, {
  voiceId: 'account-clone-1',
  name: '阿离试音',
  descriptions: ['克制，略带沙哑'],
  type: 'voice_cloning',
}]

const profile: StoryCharacterVoiceProfile = {
  version: 1,
  voiceId: 'cn-heroine',
  providerId: 'minimax-speech',
  providerConfigRevision: 7,
  voiceType: 'system',
  voiceName: '英气少女',
  descriptions: ['年轻、坚定的普通话女声'],
  selectionSource: 'agentic',
  catalogFingerprint: 'a'.repeat(64),
  catalogObservedAt: '2026-07-14T00:00:00.000Z',
  historicalPin: false,
  updatedAt: '2026-07-14T00:01:00.000Z',
  defaultDelivery: { emotion: 'calm', speed: 0.95, pitch: 0 },
  sceneDirections: [{
    sceneId: 'cliff',
    emotion: 'whisper',
    speed: 0.82,
    pitch: -1,
    rationale: '压低声音表现警觉。',
  }],
}

test('catalog search matches provider name, description, type and voice id without fabricating entries', () => {
  assert.deepEqual(filterMiniMaxVoices(voices, '英气').map((voice) => voice.voiceId), ['cn-heroine'])
  assert.deepEqual(filterMiniMaxVoices(voices, '克隆 沙哑').map((voice) => voice.voiceId), ['account-clone-1'])
  assert.deepEqual(filterMiniMaxVoices(voices, 'does-not-exist'), [])
  assert.equal(filterMiniMaxVoices(voices, '').length, voices.length)
})

test('dialogue inherits only an exact character identity and narration is never guessed', () => {
  const story = {
    characters: [{ id: 'ali', name: '阿离' }],
  } as unknown as StoryDocument
  assert.equal(characterForDialogueLine(story, {
    id: 'line-1', sequence: 1, kind: 'dialogue', speaker: '阿离', text: '走。',
  })?.id, 'ali')
  assert.equal(characterForDialogueLine(story, {
    id: 'line-2', sequence: 2, kind: 'dialogue', speaker: '阿离（少年）', text: '走。',
  }), null)
  assert.equal(characterForDialogueLine(story, {
    id: 'line-3', sequence: 3, kind: 'narration', speaker: '阿离', text: '夜色沉下。',
  }), null)
})

test('narration inherits only the project narrator while dialogue behavior remains character-scoped', () => {
  const story = {
    characters: [{ id: 'ali', name: '阿离', voiceProfile: profile }],
  } as unknown as StoryDocument
  const narratorProfile = { ...profile, voiceId: 'narrator-1', voiceName: '项目旁白' }

  assert.deepEqual(voiceProfileForStoryLine({
    story,
    line: { id: 'n1', sequence: 0, kind: 'narration', speaker: '阿离', text: '夜色沉下。' },
    narratorVoiceProfile: narratorProfile,
  }), {
    scope: 'project-narrator',
    character: null,
    profile: narratorProfile,
  })
  assert.deepEqual(voiceProfileForStoryLine({
    story,
    line: { id: 'n2', sequence: 1, kind: 'narration', speaker: '旁白', text: '风起。' },
    narratorVoiceProfile: null,
  }), {
    scope: 'project-narrator',
    character: null,
    profile: null,
  })
  assert.equal(voiceProfileForStoryLine({
    story,
    line: { id: 'd1', sequence: 2, kind: 'dialogue', speaker: '阿离', text: '走。' },
    narratorVoiceProfile: narratorProfile,
  }).profile, profile)
})

test('scene delivery wins over character default and reports its auditable rationale', () => {
  assert.deepEqual(resolveCharacterVoiceDelivery(profile, 'cliff'), {
    delivery: { emotion: 'whisper', speed: 0.82, pitch: -1 },
    source: 'scene',
    rationale: '压低声音表现警觉。',
  })
  assert.equal(resolveCharacterVoiceDelivery(profile, 'market').source, 'character-default')
  assert.deepEqual(resolveCharacterVoiceDelivery(undefined, 'market').delivery, {
    emotion: 'calm', speed: 1, pitch: 0,
  })
})

test('historical fractional MiniMax pitch is projected to a valid whole semitone', () => {
  assert.equal(normalizeMiniMaxPitch(0.02), 0)
  assert.equal(normalizeMiniMaxPitch(-0.51), -1)
  assert.equal(resolveCharacterVoiceDelivery({
    ...profile,
    defaultDelivery: { emotion: 'calm', speed: 1, pitch: 0.05 },
  }, 'market').delivery.pitch, 0)
})

test('speech workbench shows one actionable error instead of stacking stale history', () => {
  assert.equal(dialogueSpeechErrorMessage({
    submissionError: '',
    jobStale: true,
    jobStatus: 'failed',
    jobErrorMessage: 'MiniMax 资源限制 (2056)',
  }), '剧本或声线已修改，历史音频任务不再属于当前修订；请按当前配置重新合成。')
  assert.equal(dialogueSpeechErrorMessage({
    submissionError: '当前参数无效',
    jobStale: true,
    jobStatus: 'failed',
    jobErrorMessage: '旧任务错误',
  }), '当前参数无效')
  assert.equal(dialogueSpeechErrorMessage({
    submissionError: '',
    jobStale: false,
    jobStatus: 'failed',
    jobErrorMessage: 'MiniMax Token Plan 资源额度已用尽',
  }), 'MiniMax Token Plan 资源额度已用尽')
})

test('historical or changed catalogs cannot silently confirm a stale recommendation/profile', () => {
  assert.equal(isVoiceProfileCurrentForCatalog(profile, {
    providerConfigRevision: 7,
    fingerprint: 'a'.repeat(64),
  }), true)
  assert.equal(isVoiceProfileCurrentForCatalog({ ...profile, historicalPin: true }, {
    providerConfigRevision: 7,
    fingerprint: 'a'.repeat(64),
  }), false)
  assert.equal(recommendationCanBeConfirmed({
    recommendationFingerprint: 'a'.repeat(64),
    selectedVoiceId: 'cn-heroine',
    catalog: { fingerprint: 'a'.repeat(64), voices },
  }), true)
  assert.equal(recommendationCanBeConfirmed({
    recommendationFingerprint: 'b'.repeat(64),
    selectedVoiceId: 'cn-heroine',
    catalog: { fingerprint: 'a'.repeat(64), voices },
  }), false)
})

test('character inheritance omits provider and voice while an explicit line override pins MiniMax', () => {
  assert.deepEqual(dialogueVoiceSubmissionPlan({
    profile,
    overrideVoice: null,
    overrideEnabled: false,
  }), { mode: 'inherit', request: {} })
  assert.deepEqual(dialogueVoiceSubmissionPlan({
    profile,
    overrideVoice: voices[1],
    overrideEnabled: true,
  }), {
    mode: 'override',
    request: { providerId: 'minimax-speech', voiceId: 'account-clone-1' },
  })
  assert.deepEqual(dialogueVoiceSubmissionPlan({
    profile: null,
    overrideVoice: null,
    overrideEnabled: false,
  }), { mode: 'missing', request: {} })
})

test('agentic confirmation references the durable job and never sends a client-authored rationale', () => {
  const input = characterVoiceProfileConfirmationInput({
    projectId: 'project-1',
    voiceId: 'account-clone-1',
    providerConfigRevision: 7,
    recommendationJobId: 'recommendation-job-1',
  })
  assert.deepEqual(input, {
    projectId: 'project-1',
    voiceId: 'account-clone-1',
    selectionSource: 'agentic',
    recommendationJobId: 'recommendation-job-1',
    expectedProviderConfigRevision: 7,
  })
  assert.equal('selectionRationale' in input, false)
})
