import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  DialoguePerformanceProfile,
  DialoguePerformanceRecommendationJob,
} from '../src/lib/api-types'
import {
  applyLinePerformanceProfile,
  linePerformanceSummary,
  recommendationCanBeAdopted,
} from '../src/features/voices/line-performance-state'

const recommendation = {
  version: 'line-performance-agent-v1' as const,
  lineId: 'line-1',
  emotion: 'sad' as const,
  speed: 0.82,
  pitch: -2,
  pausePlan: [{ afterCharacter: 5, durationSeconds: 0.3 }],
  rationale: '收紧句尾，保留未说完的情绪。',
}

const profile: DialoguePerformanceProfile = {
  ...recommendation,
  projectId: 'project-1',
  episodeId: 'episode-1',
  databaseLineId: 'line-db-1',
  revisionId: 'profile-revision-1',
  recommendationJobId: 'job-1',
  sourceRevisionId: 'story-revision-1',
  updatedAt: '2026-07-14T08:00:00.000Z',
}

const job: DialoguePerformanceRecommendationJob = {
  id: 'job-1',
  projectId: 'project-1',
  episodeId: 'episode-1',
  type: 'dialogue.performance.recommend',
  status: 'succeeded',
  progress: 100,
  attempt: 1,
  input: {
    episodeId: 'episode-1',
    lineId: 'line-1',
    sourceRevisionId: 'story-revision-1',
    lineKind: 'dialogue',
  },
  output: { lineId: 'line-1', recommendation },
  createdAt: '2026-07-14T08:00:00.000Z',
  updatedAt: '2026-07-14T08:00:01.000Z',
}

test('default line card stays concise and names the inherited performance source', () => {
  assert.equal(
    linePerformanceSummary(null, '角色场景指令'),
    'AI 表演：沿用角色场景指令',
  )
  assert.equal(
    linePerformanceSummary(profile, '角色场景指令'),
    'AI 表演：悲伤 · 0.82× · -2 半音',
  )
})

test('AI recommendation can only be adopted when durable job and line targets agree', () => {
  assert.equal(recommendationCanBeAdopted(job, 'line-1'), true)
  assert.equal(recommendationCanBeAdopted(job, 'line-2'), false)
  assert.equal(recommendationCanBeAdopted({ ...job, status: 'running' }, 'line-1'), false)
  assert.equal(recommendationCanBeAdopted({
    ...job,
    output: { lineId: 'line-2', recommendation: { ...recommendation, lineId: 'line-2' } },
  }, 'line-1'), false)
})

test('confirmed line performance wins over inherited delivery and delete restores inheritance', () => {
  const inherited = { emotion: 'whisper' as const, speed: 0.95, pitch: 0 }
  assert.deepEqual(applyLinePerformanceProfile(profile, inherited), {
    emotion: 'sad', speed: 0.82, pitch: -2,
  })
  assert.deepEqual(applyLinePerformanceProfile(null, inherited), inherited)
})
