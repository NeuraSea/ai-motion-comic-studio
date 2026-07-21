import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CharacterVoicePreviewJob,
  ProjectNarratorVoicePreviewJob,
  VoicePreviewReview,
} from '../src/lib'
import {
  buildVoiceAcceptanceItems,
  type VoiceAcceptanceTarget,
} from '../src/features/voices/voice-acceptance-state'

const narratorTarget: VoiceAcceptanceTarget = {
  key: 'project_narrator',
  subjectType: 'project_narrator',
  subjectId: 'project-1',
  name: '项目旁白',
  voiceId: 'narrator-voice',
}

const characterTarget: VoiceAcceptanceTarget = {
  key: 'character:c1',
  subjectType: 'character',
  subjectId: 'c1',
  name: '角色 · 阿离',
  voiceId: 'character-voice',
}

function previewJob(
  subject: 'narrator' | 'character',
  overrides: Partial<CharacterVoicePreviewJob | ProjectNarratorVoicePreviewJob> = {},
): CharacterVoicePreviewJob | ProjectNarratorVoicePreviewJob {
  const character = subject === 'character'
  return {
    id: `${subject}-job`,
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: character ? 'character.voice.preview' : 'project.narrator.voice.preview',
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    retryDisposition: 'not-retryable',
    input: {
      episodeId: 'episode-1',
      ...(character ? { characterId: 'c1' } : {}),
      expectedStoryRevisionId: 'story-r1',
      voiceId: character ? 'character-voice' : 'narrator-voice',
      expectedCatalogFingerprint: 'catalog-1',
      expectedProviderConfigRevision: 4,
    },
    output: {
      ...(character ? { characterId: 'c1' } : { episodeId: 'episode-1' }),
      voiceId: character ? 'character-voice' : 'narrator-voice',
      sampleSource: character ? 'dialogue' : 'narration',
      sampleCharacterCount: 8,
      asset: {
        id: `${subject}-asset`,
        projectId: 'project-1',
        episodeId: 'episode-1',
        kind: character ? 'character.voice.preview' : 'project.narrator.voice.preview',
        version: 1,
        status: 'ready',
        url: `/asset/${subject}`,
        mimeType: 'audio/mpeg',
        source: 'provider',
        createdAt: '2026-07-16T00:00:00.000Z',
        updatedAt: '2026-07-16T00:00:00.000Z',
      },
      provider: { id: 'minimax-speech', model: 'speech-2.8-hd', configRevision: 4 },
    },
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:01.000Z',
    completedAt: '2026-07-16T00:00:01.000Z',
    ...overrides,
  } as CharacterVoicePreviewJob | ProjectNarratorVoicePreviewJob
}

function review(jobId: string, decision: 'approve' | 'reject', isCurrent = true): VoicePreviewReview {
  return {
    id: `${jobId}-review`,
    projectId: 'project-1',
    episodeId: 'episode-1',
    subjectType: jobId.startsWith('character') ? 'character' : 'project_narrator',
    subjectId: jobId.startsWith('character') ? 'c1' : 'project-1',
    previewJobId: jobId,
    previewAssetId: `${jobId}-asset`,
    previewAssetChecksum: 'a'.repeat(64),
    voiceId: jobId.startsWith('character') ? 'character-voice' : 'narrator-voice',
    providerId: 'minimax-speech',
    model: 'speech-2.8-hd',
    providerConfigRevision: 4,
    catalogFingerprint: 'catalog-1',
    storyRevisionId: 'story-r1',
    decision,
    notes: null,
    playbackCompletedAt: '2026-07-16T00:01:00.000Z',
    playbackEvidence: {
      version: 'html-media-played-v1',
      durationSeconds: 2,
      ranges: [{ startSeconds: 0, endSeconds: 2 }],
    },
    reviewedAt: '2026-07-16T00:01:00.000Z',
    isCurrent,
    invalidReasons: [],
  }
}

test('voice acceptance uses only exact current previews and current immutable reviews', () => {
  const narrator = previewJob('narrator') as ProjectNarratorVoicePreviewJob
  const character = previewJob('character') as CharacterVoicePreviewJob
  const historical = previewJob('character', {
    id: 'character-old',
    input: {
      ...character.input,
      expectedStoryRevisionId: 'story-old',
    },
    completedAt: '2026-07-16T00:02:00.000Z',
  }) as CharacterVoicePreviewJob
  const result = buildVoiceAcceptanceItems({
    episodeId: 'episode-1',
    sourceRevisionId: 'story-r1',
    targets: [narratorTarget, characterTarget],
    narratorJobs: [narrator],
    characterJobs: [historical, character],
    reviewsByJobId: new Map([
      [narrator.id, [review(narrator.id, 'approve')]],
      [character.id, [review(character.id, 'reject')]],
      [historical.id, [review(historical.id, 'approve')]],
    ]),
  })
  assert.deepEqual(result.map((item) => [item.target.key, item.status, item.previewJobId]), [
    ['project_narrator', 'approved', narrator.id],
    ['character:c1', 'rejected', character.id],
  ])
})

test('voice acceptance distinguishes missing profiles, missing previews, and pending playback', () => {
  const narrator = previewJob('narrator') as ProjectNarratorVoicePreviewJob
  const result = buildVoiceAcceptanceItems({
    episodeId: 'episode-1',
    sourceRevisionId: 'story-r1',
    targets: [
      narratorTarget,
      { ...characterTarget, voiceId: null },
      { ...characterTarget, key: 'character:c2', subjectId: 'c2', name: '角色 · 林澈' },
    ],
    narratorJobs: [narrator],
    characterJobs: [],
    reviewsByJobId: new Map(),
  })
  assert.deepEqual(result.map((item) => item.status), [
    'review-pending',
    'profile-missing',
    'preview-missing',
  ])
})
