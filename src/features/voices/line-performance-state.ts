import type {
  DialoguePerformanceProfile,
  DialoguePerformanceRecommendation,
  DialoguePerformanceRecommendationJob,
  StoryCharacterVoiceDelivery,
} from '../../lib/api-types'

export const LINE_PERFORMANCE_EMOTION_LABELS: Record<
  DialoguePerformanceRecommendation['emotion'],
  string
> = {
  happy: '开心',
  sad: '悲伤',
  angry: '愤怒',
  fearful: '恐惧',
  disgusted: '厌恶',
  surprised: '惊讶',
  calm: '平静',
}

export function linePerformanceDelivery(
  profile: DialoguePerformanceProfile | DialoguePerformanceRecommendation,
): StoryCharacterVoiceDelivery {
  return {
    emotion: profile.emotion,
    speed: profile.speed,
    pitch: profile.pitch,
  }
}

export function applyLinePerformanceProfile(
  profile: DialoguePerformanceProfile | null,
  inherited: StoryCharacterVoiceDelivery,
): StoryCharacterVoiceDelivery {
  return profile ? linePerformanceDelivery(profile) : inherited
}

export function linePerformanceSummary(
  performance: DialoguePerformanceProfile | DialoguePerformanceRecommendation | null,
  inheritedLabel: string,
): string {
  if (!performance) return `AI 表演：沿用${inheritedLabel}`
  const pitch = `${performance.pitch > 0 ? '+' : ''}${performance.pitch} 半音`
  return `AI 表演：${LINE_PERFORMANCE_EMOTION_LABELS[performance.emotion]} · ${performance.speed.toFixed(2)}× · ${pitch}`
}

export function recommendationCanBeAdopted(
  job: DialoguePerformanceRecommendationJob | null,
  lineId: string,
): job is DialoguePerformanceRecommendationJob & {
  status: 'succeeded'
  output: NonNullable<DialoguePerformanceRecommendationJob['output']>
} {
  return Boolean(job
    && job.status === 'succeeded'
    && job.input.lineId === lineId
    && job.output?.lineId === lineId
    && job.output.recommendation.lineId === lineId)
}
