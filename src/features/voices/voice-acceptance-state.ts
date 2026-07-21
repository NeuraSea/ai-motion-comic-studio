import type {
  CharacterVoicePreviewJob,
  ProjectNarratorVoicePreviewJob,
  VoicePreviewReview,
} from '../../lib'

export interface VoiceAcceptanceTarget {
  key: string
  subjectType: 'project_narrator' | 'character'
  subjectId: string
  name: string
  voiceId: string | null
}

export type VoiceAcceptanceStatus =
  | 'profile-missing'
  | 'preview-missing'
  | 'review-pending'
  | 'approved'
  | 'rejected'

export interface VoiceAcceptanceItem {
  target: VoiceAcceptanceTarget
  status: VoiceAcceptanceStatus
  previewJobId: string | null
  previewAssetUrl: string | null
  review: VoicePreviewReview | null
}

function newestFirst(
  left: CharacterVoicePreviewJob | ProjectNarratorVoicePreviewJob,
  right: CharacterVoicePreviewJob | ProjectNarratorVoicePreviewJob,
): number {
  return Date.parse(right.completedAt ?? right.updatedAt)
    - Date.parse(left.completedAt ?? left.updatedAt)
}

export function buildVoiceAcceptanceItems(input: {
  episodeId: string
  sourceRevisionId: string
  targets: readonly VoiceAcceptanceTarget[]
  narratorJobs: readonly ProjectNarratorVoicePreviewJob[]
  characterJobs: readonly CharacterVoicePreviewJob[]
  reviewsByJobId: ReadonlyMap<string, readonly VoicePreviewReview[]>
}): VoiceAcceptanceItem[] {
  return input.targets.map((target) => {
    if (!target.voiceId) {
      return {
        target,
        status: 'profile-missing',
        previewJobId: null,
        previewAssetUrl: null,
        review: null,
      }
    }
    const candidates = (target.subjectType === 'project_narrator'
      ? input.narratorJobs.filter((job) => (
          job.episodeId === input.episodeId
          && job.input.episodeId === input.episodeId
          && job.input.expectedStoryRevisionId === input.sourceRevisionId
          && job.input.voiceId === target.voiceId
          && job.status === 'succeeded'
          && Boolean(job.output)
        ))
      : input.characterJobs.filter((job) => (
          job.episodeId === input.episodeId
          && job.input.episodeId === input.episodeId
          && job.input.characterId === target.subjectId
          && job.input.expectedStoryRevisionId === input.sourceRevisionId
          && job.input.voiceId === target.voiceId
          && job.status === 'succeeded'
          && Boolean(job.output)
        )))
      .slice()
      .sort(newestFirst)
    const preview = candidates[0] ?? null
    if (!preview?.output) {
      return {
        target,
        status: 'preview-missing',
        previewJobId: null,
        previewAssetUrl: null,
        review: null,
      }
    }
    const review = (input.reviewsByJobId.get(preview.id) ?? [])
      .find((candidate) => candidate.isCurrent) ?? null
    return {
      target,
      status: review?.decision === 'approve'
        ? 'approved'
        : review?.decision === 'reject'
          ? 'rejected'
          : 'review-pending',
      previewJobId: preview.id,
      previewAssetUrl: preview.output.asset.url,
      review,
    }
  })
}

