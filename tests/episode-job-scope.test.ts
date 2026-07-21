import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExportRenderRecord, GenerationJob, QualityReport } from '../src/lib/api-types'
import {
  completedSpeechLineIdsForCurrentStory,
  exportRecordBelongsToCurrentStory,
  jobBelongsToCurrentStoryRevision,
  jobsForEpisode,
  latestExportJobForCurrentStory,
  latestQualityJobForExport,
  qualityReportBelongsToCurrentStory,
  sourceRevisionIdForJob,
} from '../src/features/jobs/episode-job-scope'

function job(overrides: Partial<GenerationJob> & Pick<GenerationJob, 'id' | 'type'>): GenerationJob {
  return {
    id: overrides.id,
    projectId: 'project-1',
    episodeId: 'episode-current',
    type: overrides.type,
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    input: {},
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:01.000Z',
    ...overrides,
  }
}

const scope = {
  episodeId: 'episode-current',
  sourceRevisionId: 'revision-current',
}

test('episode scoping requires the durable top-level Episode and rejects contradictory bindings', () => {
  const current = job({
    id: 'speech-current',
    type: 'dialogue.speech.generate',
    input: { episodeId: 'episode-current', expectedRevisionId: 'revision-current', lineId: 'line-1' },
  })
  const otherEpisode = job({
    id: 'speech-other',
    type: 'dialogue.speech.generate',
    episodeId: 'episode-other',
    input: { episodeId: 'episode-other', expectedRevisionId: 'revision-current', lineId: 'line-1' },
  })
  const contradictory = job({
    id: 'video-contradictory',
    type: 'shot.video.generate',
    input: {
      binding: { episodeId: 'episode-other', expectedRevisionId: 'revision-current' },
    },
  })

  assert.deepEqual(jobsForEpisode([otherEpisode, contradictory, current], scope.episodeId), [current])
})

test('speech completion uses only the current Episode and current immutable Story revision', () => {
  const jobs = [
    job({
      id: 'current-line',
      type: 'dialogue.speech.generate',
      input: { episodeId: scope.episodeId, expectedRevisionId: scope.sourceRevisionId, lineId: 'line-1' },
    }),
    job({
      id: 'old-line',
      type: 'dialogue.speech.generate',
      input: { episodeId: scope.episodeId, expectedRevisionId: 'revision-old', lineId: 'line-2' },
    }),
    job({
      id: 'other-episode-line',
      type: 'dialogue.speech.generate',
      episodeId: 'episode-other',
      input: { episodeId: 'episode-other', expectedRevisionId: scope.sourceRevisionId, lineId: 'line-3' },
    }),
    job({
      id: 'stale-line',
      type: 'dialogue.speech.generate',
      input: { episodeId: scope.episodeId, expectedRevisionId: scope.sourceRevisionId, lineId: 'line-4' },
      progressDetail: { stale: true },
    }),
  ]

  assert.deepEqual([...completedSpeechLineIdsForCurrentStory(jobs, scope)], ['line-1'])
})

test('latest export cannot be borrowed from another Episode or an old Story revision', () => {
  const current = job({
    id: 'export-current',
    type: 'export.render',
    updatedAt: '2026-07-15T00:00:01.000Z',
    input: { exportId: 'export-current' },
    output: { exportId: 'export-current', storyRevisionId: scope.sourceRevisionId },
  })
  const queuedCurrent = job({
    id: 'export-current-queued',
    type: 'export.render',
    status: 'queued',
    progress: 0,
    updatedAt: '2026-07-15T00:00:02.000Z',
    input: {
      exportId: 'export-current-queued',
      timelineRevisionId: 'timeline-current',
      storyRevisionId: scope.sourceRevisionId,
    },
    output: null,
  })
  const oldRevision = job({
    id: 'export-old-revision',
    type: 'export.render',
    updatedAt: '2026-07-15T00:00:03.000Z',
    input: { exportId: 'export-old-revision' },
    output: { exportId: 'export-old-revision', storyRevisionId: 'revision-old' },
  })
  const otherEpisode = job({
    id: 'export-other-episode',
    type: 'export.render',
    episodeId: 'episode-other',
    updatedAt: '2026-07-15T00:00:04.000Z',
    input: { exportId: 'export-other-episode' },
    output: { exportId: 'export-other-episode', storyRevisionId: scope.sourceRevisionId },
  })

  assert.equal(
    latestExportJobForCurrentStory([otherEpisode, oldRevision, current, queuedCurrent], scope)?.id,
    queuedCurrent.id,
  )
})

test('quality selection is chained to the selected current export and current Episode', () => {
  const current = job({
    id: 'quality-current',
    type: 'quality.check',
    input: { exportId: 'export-current', qualityReportId: 'report-current' },
  })
  const otherExport = job({
    id: 'quality-other-export',
    type: 'quality.check',
    updatedAt: '2026-07-15T00:00:03.000Z',
    input: { exportId: 'export-old', qualityReportId: 'report-old' },
  })
  const otherEpisode = job({
    id: 'quality-other-episode',
    type: 'quality.check',
    episodeId: 'episode-other',
    updatedAt: '2026-07-15T00:00:04.000Z',
    input: { exportId: 'export-current', qualityReportId: 'report-other' },
  })

  assert.equal(
    latestQualityJobForExport([otherEpisode, otherExport, current], scope.episodeId, 'export-current')?.id,
    current.id,
  )
})

test('conflicting immutable revision pointers never resolve as current', () => {
  const conflicting = job({
    id: 'conflicting',
    type: 'shot.video.generate',
    input: {
      binding: { episodeId: scope.episodeId, expectedRevisionId: scope.sourceRevisionId },
    },
    output: {
      storyRevisionId: 'revision-old',
    },
  })

  assert.equal(sourceRevisionIdForJob(conflicting), null)
  assert.equal(jobBelongsToCurrentStoryRevision(conflicting, scope), false)
})

test('loaded export and quality records are rejected when their Story authority is old', () => {
  const exportRecord = {
    id: 'export-current',
    projectId: 'project-1',
    episodeId: scope.episodeId,
    status: 'succeeded',
    timelineRevisionId: 'timeline-current',
    storyRevisionId: scope.sourceRevisionId,
    specification: {
      version: 1,
      resolution: '720p',
      aspectRatio: '16:9',
      kenBurns: true,
      burnSubtitles: true,
      introTitle: false,
      outroCard: false,
      reviewWatermark: false,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      frameRate: 24,
      audioCodec: 'aac',
      audioSampleRate: 48_000,
      timelineRevisionId: 'timeline-current',
      storyRevisionId: scope.sourceRevisionId,
    },
    outputAsset: null,
    downloadUrl: null,
    jobId: 'export-job',
    error: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:01.000Z',
    completedAt: '2026-07-15T00:00:01.000Z',
  } satisfies ExportRenderRecord
  const qualityReport = {
    id: 'quality-current',
    projectId: 'project-1',
    episodeId: scope.episodeId,
    exportId: exportRecord.id,
    outputAssetId: 'asset-current',
    outputAssetChecksum: 'a'.repeat(64),
    timelineRevisionId: exportRecord.timelineRevisionId,
    storyRevisionId: scope.sourceRevisionId,
    status: 'passed',
    passed: true,
    policy: {},
    expected: {},
    checks: [],
    metrics: {},
    summary: { passed: true, failedChecks: 0, warningChecks: 0 },
    jobId: 'quality-job',
    jobStatus: 'succeeded',
    error: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    completedAt: '2026-07-15T00:00:01.000Z',
  } satisfies QualityReport

  assert.equal(exportRecordBelongsToCurrentStory(exportRecord, scope, exportRecord.id), true)
  assert.equal(qualityReportBelongsToCurrentStory(qualityReport, scope, exportRecord.id), true)
  assert.equal(exportRecordBelongsToCurrentStory({
    ...exportRecord,
    storyRevisionId: 'revision-old',
    specification: { ...exportRecord.specification, storyRevisionId: 'revision-old' },
  }, scope, exportRecord.id), false)
  assert.equal(qualityReportBelongsToCurrentStory({
    ...qualityReport,
    storyRevisionId: 'revision-old',
  }, scope, exportRecord.id), false)
})
