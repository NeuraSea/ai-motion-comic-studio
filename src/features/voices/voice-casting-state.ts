import type {
  MiniMaxVoiceCatalogEntry,
  PutCharacterVoiceProfileInput,
  StoryCharacter,
  StoryCharacterVoiceDelivery,
  StoryCharacterVoiceProfile,
  StoryDialogueLine,
  StoryDocument,
} from '../../lib'

export const VOICE_TYPE_LABELS: Record<MiniMaxVoiceCatalogEntry['type'], string> = {
  system: '系统音色',
  voice_cloning: '克隆音色',
  voice_generation: '设计音色',
}

export const VOICE_EMOTION_LABELS: Record<StoryCharacterVoiceDelivery['emotion'], string> = {
  happy: '开心',
  sad: '悲伤',
  angry: '愤怒',
  fearful: '恐惧',
  disgusted: '厌恶',
  surprised: '惊讶',
  calm: '平静',
  fluent: '流畅',
  whisper: '耳语',
}

function searchableVoiceText(voice: MiniMaxVoiceCatalogEntry): string {
  return [voice.name, voice.voiceId, VOICE_TYPE_LABELS[voice.type], ...voice.descriptions]
    .join('\n')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
}

/**
 * Searches only the provider-authored catalog. It never manufactures a voice
 * or silently treats arbitrary text as a voice_id.
 */
export function filterMiniMaxVoices(
  voices: readonly MiniMaxVoiceCatalogEntry[],
  query: string,
): MiniMaxVoiceCatalogEntry[] {
  const terms = query
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/u)
    .filter(Boolean)
  if (terms.length === 0) return [...voices]
  return voices.filter((voice) => {
    const haystack = searchableVoiceText(voice)
    return terms.every((term) => haystack.includes(term))
  })
}

export function findCatalogVoice(
  voices: readonly MiniMaxVoiceCatalogEntry[],
  voiceId: string | null | undefined,
): MiniMaxVoiceCatalogEntry | null {
  if (!voiceId) return null
  return voices.find((voice) => voice.voiceId === voiceId) ?? null
}

/** Exact character-name matching is intentional; fuzzy matching could assign
 * one actor's voice to another character without an auditable user decision. */
export function characterForDialogueLine(
  story: StoryDocument | null,
  line: StoryDialogueLine | null | undefined,
): StoryCharacter | null {
  if (!story || !line || line.kind !== 'dialogue') return null
  const speaker = line.speaker.normalize('NFKC').trim()
  if (!speaker) return null
  return story.characters.find((character) => (
    character.name.normalize('NFKC').trim() === speaker
  )) ?? null
}

export type StoryLineVoiceProfileResolution =
  | {
      scope: 'project-narrator'
      character: null
      profile: StoryCharacterVoiceProfile | null
    }
  | {
      scope: 'character'
      character: StoryCharacter
      profile: StoryCharacterVoiceProfile | null
    }
  | {
      scope: 'unmatched-dialogue'
      character: null
      profile: null
    }

/**
 * Narration is always resolved from the one project-level narrator profile.
 * It must never fall back to a character whose name happens to be present in
 * the line, nor to an arbitrary default provider voice.
 */
export function voiceProfileForStoryLine(input: {
  story: StoryDocument | null
  line: StoryDialogueLine | null | undefined
  narratorVoiceProfile: StoryCharacterVoiceProfile | null | undefined
}): StoryLineVoiceProfileResolution {
  if (input.line?.kind === 'narration') {
    return {
      scope: 'project-narrator',
      character: null,
      profile: input.narratorVoiceProfile ?? null,
    }
  }
  const character = characterForDialogueLine(input.story, input.line)
  if (!character) {
    return { scope: 'unmatched-dialogue', character: null, profile: null }
  }
  return {
    scope: 'character',
    character,
    profile: character.voiceProfile ?? null,
  }
}

export interface ResolvedCharacterVoiceDelivery {
  delivery: StoryCharacterVoiceDelivery
  source: 'scene' | 'character-default' | 'platform-default'
  rationale: string | null
}

/** MiniMax defines pitch in whole semitones. Keep the UI defensive when it
 * opens a historical profile produced before that contract was enforced. */
export function normalizeMiniMaxPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 0
  return Math.max(-12, Math.min(12, Math.round(pitch)))
}

export function dialogueSpeechErrorMessage(input: {
  submissionError: string
  jobStale: boolean
  jobStatus: string | null | undefined
  jobErrorMessage?: string | null
}): string {
  if (input.submissionError) return input.submissionError
  if (input.jobStale) {
    return '剧本或声线已修改，历史音频任务不再属于当前修订；请按当前配置重新合成。'
  }
  if (input.jobStatus === 'failed') return input.jobErrorMessage || '语音合成失败'
  return ''
}

export function resolveCharacterVoiceDelivery(
  profile: StoryCharacterVoiceProfile | null | undefined,
  sceneId: string | null | undefined,
): ResolvedCharacterVoiceDelivery {
  const sceneDirection = sceneId
    ? profile?.sceneDirections?.find((candidate) => candidate.sceneId === sceneId)
    : undefined
  if (sceneDirection) {
    return {
      delivery: {
        emotion: sceneDirection.emotion,
        speed: sceneDirection.speed,
        pitch: normalizeMiniMaxPitch(sceneDirection.pitch),
      },
      source: 'scene',
      rationale: sceneDirection.rationale,
    }
  }
  if (profile?.defaultDelivery) {
    return {
      delivery: {
        ...profile.defaultDelivery,
        pitch: normalizeMiniMaxPitch(profile.defaultDelivery.pitch),
      },
      source: 'character-default',
      rationale: null,
    }
  }
  return {
    delivery: { emotion: 'calm', speed: 1, pitch: 0 },
    source: 'platform-default',
    rationale: null,
  }
}

export function isVoiceProfileCurrentForCatalog(
  profile: StoryCharacterVoiceProfile | null | undefined,
  catalog: { providerId?: string; providerConfigRevision: number; fingerprint: string } | null | undefined,
): boolean {
  return Boolean(profile
    && catalog
    && !profile.historicalPin
    && (catalog.providerId === undefined || profile.providerId === catalog.providerId)
    && profile.providerConfigRevision === catalog.providerConfigRevision
    && profile.catalogFingerprint === catalog.fingerprint)
}

export function recommendationCanBeConfirmed(input: {
  recommendationFingerprint: string
  selectedVoiceId: string
  catalog: { fingerprint: string; voices: readonly MiniMaxVoiceCatalogEntry[] } | null
}): boolean {
  return Boolean(input.catalog
    && input.recommendationFingerprint === input.catalog.fingerprint
    && input.catalog.voices.some((voice) => voice.voiceId === input.selectedVoiceId))
}

export function characterVoiceProfileConfirmationInput(input: {
  projectId: string
  providerId?: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
  voiceId: string
  providerConfigRevision: number
  recommendationJobId?: string
}): PutCharacterVoiceProfileInput {
  return {
    projectId: input.projectId,
    ...(input.providerId ? { providerId: input.providerId } : {}),
    voiceId: input.voiceId,
    selectionSource: input.recommendationJobId ? 'agentic' : 'manual',
    ...(input.recommendationJobId ? { recommendationJobId: input.recommendationJobId } : {}),
    expectedProviderConfigRevision: input.providerConfigRevision,
  }
}

export type DialogueVoiceSubmissionPlan =
  | { mode: 'inherit'; request: Record<string, never> }
  | { mode: 'override'; request: { providerId: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'; voiceId: string } }
  | { mode: 'missing'; request: Record<string, never> }

/**
 * Inheritance deliberately omits both providerId and voiceId so the server
 * resolves the auditable profile revision atomically. Only an explicit
 * single-line catalog choice sends an override.
 */
export function dialogueVoiceSubmissionPlan(input: {
  profile: StoryCharacterVoiceProfile | null | undefined
  overrideVoice: MiniMaxVoiceCatalogEntry | null | undefined
  overrideProviderId?: 'minimax-speech' | 'indextts-speech' | 'doubao-speech'
  overrideEnabled: boolean
}): DialogueVoiceSubmissionPlan {
  if (input.overrideEnabled) {
    return input.overrideVoice
      ? {
          mode: 'override',
          request: {
            providerId: input.overrideProviderId ?? 'minimax-speech',
            voiceId: input.overrideVoice.voiceId,
          },
        }
      : { mode: 'missing', request: {} }
  }
  return input.profile
    ? { mode: 'inherit', request: {} }
    : { mode: 'missing', request: {} }
}
