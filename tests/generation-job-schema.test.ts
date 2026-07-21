import assert from 'node:assert/strict'
import test from 'node:test'

import {
  generationJobFromEventData,
  isGenerationJob,
} from '../src/lib/generation-job-schema'
import {
  ApiError,
  listGenerationJobs,
} from '../src/lib/api'

function completeResolvedVideoJob(): Record<string, unknown> {
  return {
    id: 'job-video-resolved-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: 'pipeline-1',
    type: 'shot.video.generate',
    status: 'failed',
    progress: 37,
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: 'seedance-1-0-pro-250528',
    providerConfigRevision: 7,
    externalTaskId: null,
    idempotencyKey: 'shot-video:shot-1:revision-4',
    retryOf: null,
    attempt: 1,
    input: {
      prompt: 'The swordswoman crosses the moonlit courtyard.',
      binding: { shotId: 'shot-1', expectedSourceRevisionId: 'revision-4' },
    },
    progressDetail: { stage: 'manual-resolution-recorded' },
    output: null,
    error: {
      code: 'PROVIDER_SUBMISSION_CONFIRMED_NOT_CREATED',
      message: 'Provider console inspection confirmed that no task was created.',
      retryable: false,
      category: 'manual_resolution',
    },
    cost: { currency: 'CNY', amount: 0 },
    retryDisposition: 'paid-reconfirmation-required',
    providerDiagnostic: {
      operation: 'create',
      protocol: 'ark',
      endpointFamily: 'ark-tasks',
      httpStatus: 504,
      providerCode: 'UpstreamTimeout',
      observedAt: '2026-07-15T01:00:05.000Z',
    },
    unknownSubmissionResolution: {
      version: 1,
      auditRevisionId: 'audit-revision-1',
      jobId: 'job-video-resolved-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      expectedSourceRevisionId: 'revision-4',
      resolution: 'confirmed-not-created',
      confirmedProviderConsoleChecked: true,
      note: 'Checked the immutable Provider configuration in the Provider console.',
      resolvedAt: '2026-07-15T01:05:00.000Z',
      provider: {
        id: 'seedance-video',
        configRevision: 7,
        model: 'seedance-1-0-pro-250528',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      },
    },
    createdAt: '2026-07-15T01:00:00.000Z',
    updatedAt: '2026-07-15T01:05:00.000Z',
    startedAt: '2026-07-15T01:00:01.000Z',
    completedAt: '2026-07-15T01:05:00.000Z',
  }
}

function completeCancelledVideoJob(): Record<string, unknown> {
  const {
    unknownSubmissionResolution: _unknownSubmissionResolution,
    ...job
  } = completeResolvedVideoJob()
  return {
    ...job,
    id: 'job-video-cancelled-1',
    status: 'cancelled',
    externalTaskId: 'provider-task-1',
    error: null,
    retryDisposition: 'resume-existing-provider-task',
    cancellation: {
      localProcessing: 'stopped',
      upstreamCancellation: 'request-sent',
      providerTaskMayContinue: true,
      chargesMayStillApply: true,
      message: 'Local polling stopped; the Provider cancellation result is not yet known.',
    },
  }
}

function durationBinding(
  assetId: string,
  durationSeconds: number,
  checksumCharacter: string,
): Record<string, unknown> {
  return {
    dialogueLineId: 'line-1',
    assetId,
    version: 1,
    checksum: checksumCharacter.repeat(64),
    durationSeconds,
    durationFrames: Math.ceil(durationSeconds * 24),
  }
}

function durationDecision(
  binding: Record<string, unknown>,
): Record<string, unknown> {
  const durationSeconds = Number(binding.durationSeconds)
  return {
    version: 1,
    source: 'speech_assets',
    frameRate: 24,
    plannedDurationSeconds: 5,
    speechDurationSeconds: durationSeconds,
    timelineDurationSeconds: durationSeconds,
    providerDurationSeconds: Math.max(4, Math.ceil(durationSeconds)),
    speechBindings: [binding],
    notices: ['AUDIO_DRIVEN_TIMELINE', 'PROVIDER_MINIMUM_SOURCE_WILL_BE_TRIMMED'],
  }
}

function staleAudioTimingJob(): Record<string, unknown> {
  const previousBinding = durationBinding('speech-old', 2, 'a')
  const currentBinding = durationBinding('speech-new', 3, 'b')
  const previousDecision = durationDecision(previousBinding)
  const currentDecision = durationDecision(currentBinding)
  return {
    id: 'job-video-stale-timing-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    pipelineRunId: null,
    type: 'shot.video.generate',
    status: 'failed',
    progress: 4,
    resourceType: 'provider:video',
    resourceId: 'shot-1',
    providerId: 'seedance-video',
    model: 'doubao-seedance-2-0-260128',
    providerConfigRevision: 7,
    externalTaskId: null,
    idempotencyKey: 'shot-video:shot-1:revision-4',
    retryOf: null,
    attempt: 1,
    input: {
      prompt: 'The swordswoman crosses the moonlit courtyard.',
      durationDecision: previousDecision,
      binding: {
        episodeId: 'episode-1',
        shotId: 'shot-1',
        sceneId: 'scene-1',
        databaseShotId: 'database-shot-1',
        expectedRevisionId: 'revision-4',
        expectedPreviousVideoAssetId: null,
      },
    },
    progressDetail: { stage: 'pre-submit-audio-timing-check' },
    output: null,
    error: {
      code: 'STALE_AUDIO_TIMING',
      message: 'Audio timing changed after preflight.',
      retryable: false,
      category: 'validation',
    },
    cost: null,
    retryDisposition: 'paid-reconfirmation-required',
    timingRemediation: {
      version: 1,
      kind: 'stale_audio_timing',
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      sourceRevisionId: 'revision-4',
      checkpoint: 'pre-submit',
      providerSubmissionState: 'not-started',
      detectedAt: '2026-07-15T02:00:00.000Z',
      previousDecision,
      currentResolution: { status: 'ready', decision: currentDecision },
      affectedLines: [{
        dialogueLineId: 'line-1',
        change: 'asset_changed',
        previous: {
          assetId: previousBinding.assetId,
          version: previousBinding.version,
          checksum: previousBinding.checksum,
          durationSeconds: previousBinding.durationSeconds,
          durationFrames: previousBinding.durationFrames,
        },
        current: {
          assetId: currentBinding.assetId,
          version: currentBinding.version,
          checksum: currentBinding.checksum,
          durationSeconds: currentBinding.durationSeconds,
          durationFrames: currentBinding.durationFrames,
        },
      }],
      recommendedAction: 'repreflight-paid-video',
    },
    createdAt: '2026-07-15T01:59:00.000Z',
    updatedAt: '2026-07-15T02:00:00.000Z',
    startedAt: '2026-07-15T01:59:01.000Z',
    completedAt: '2026-07-15T02:00:00.000Z',
  }
}

test('isGenerationJob accepts complete valid public Job projections', () => {
  assert.equal(isGenerationJob(completeResolvedVideoJob()), true)
  assert.equal(isGenerationJob(completeCancelledVideoJob()), true)
  assert.equal(isGenerationJob(staleAudioTimingJob()), true)
})

test('platform cost policy is strict without rejecting legacy usage-only metadata', () => {
  const legacy = completeResolvedVideoJob()
  assert.equal(isGenerationJob(legacy), true)

  const classified = structuredClone(legacy)
  classified.cost = {
    currency: 'CNY',
    amount: null,
    platformPolicy: {
      version: 1,
      costClass: 'billable-media',
      billable: true,
      paidConfirmationRequired: true,
      upstreamProviderBilling: 'outside-platform-policy',
    },
  }
  assert.equal(isGenerationJob(classified), true)

  const downgraded = structuredClone(classified)
  ;((downgraded.cost as Record<string, unknown>).platformPolicy as Record<string, unknown>).billable = false
  assert.equal(isGenerationJob(downgraded), false)

  const unknownPolicyField = structuredClone(classified)
  ;((unknownPolicyField.cost as Record<string, unknown>).platformPolicy as Record<string, unknown>).providerKey = 'forbidden'
  assert.equal(isGenerationJob(unknownPolicyField), false)
})

test('timing remediation is strict when present while legacy stale Jobs remain visible', async (context) => {
  const valid = staleAudioTimingJob()

  await context.test('legacy record without remediation remains readable and fail-closed', () => {
    const { timingRemediation: _timingRemediation, ...legacy } = valid
    assert.equal(isGenerationJob({ ...legacy, retryDisposition: 'manual-resolution' }), true)
    assert.equal(
      isGenerationJob(legacy),
      false,
      'stripping remediation from a paid-reconfirmation event must not regain authority',
    )
  })

  await context.test('unknown affected-line change is rejected from SSE', () => {
    const malformed = structuredClone(valid)
    const remediation = malformed.timingRemediation as Record<string, unknown>
    const [line] = remediation.affectedLines as Array<Record<string, unknown>>
    line!.change = 'silently-rebound'
    assert.equal(generationJobFromEventData({ job: malformed }), null)
  })

  await context.test('binding identity with an extra field is rejected', () => {
    const malformed = structuredClone(valid)
    const remediation = malformed.timingRemediation as Record<string, unknown>
    const [line] = remediation.affectedLines as Array<Record<string, unknown>>
    ;(line!.current as Record<string, unknown>).providerUrl = 'https://example.invalid/private'
    assert.equal(isGenerationJob(malformed), false)
  })

  await context.test('malformed current-resolution union is rejected', () => {
    const malformed = structuredClone(valid)
    const remediation = malformed.timingRemediation as Record<string, unknown>
    remediation.currentResolution = {
      status: 'audio_required',
      shotId: 'shot-1',
      blockedLines: [{ dialogueLineId: 'line-1', reason: 'UNKNOWN_BLOCK' }],
    }
    remediation.recommendedAction = 'regenerate-speech-or-repreflight'
    assert.equal(isGenerationJob(malformed), false)
  })

  await context.test('scope and checkpoint/provider state mismatches are rejected', () => {
    const wrongScope = structuredClone(valid)
    ;(wrongScope.timingRemediation as Record<string, unknown>).episodeId = 'episode-other'
    assert.equal(isGenerationJob(wrongScope), false)

    const wrongCheckpoint = structuredClone(valid)
    const remediation = wrongCheckpoint.timingRemediation as Record<string, unknown>
    remediation.checkpoint = 'pre-publish'
    assert.equal(isGenerationJob(wrongCheckpoint), false)
  })

  await context.test('empty affected lines use the resolution as authority', () => {
    const blocked = structuredClone(valid)
    const remediation = blocked.timingRemediation as Record<string, unknown>
    remediation.currentResolution = {
      status: 'audio_required',
      shotId: 'shot-1',
      blockedLines: [{ dialogueLineId: 'line-new', reason: 'SPEECH_ASSET_MISSING' }],
    }
    remediation.affectedLines = []
    remediation.recommendedAction = 'regenerate-speech-or-repreflight'
    assert.equal(isGenerationJob(blocked), true)
  })
})

test('isGenerationJob rejects unknown and missing retry dispositions', () => {
  assert.equal(isGenerationJob({
    ...completeResolvedVideoJob(),
    retryDisposition: 'retry-without-confirmation',
  }), false)

  const { retryDisposition: _retryDisposition, ...missingDisposition } = completeResolvedVideoJob()
  assert.equal(isGenerationJob(missingDisposition), false)
})

test('isGenerationJob rejects malformed privileged Job diagnostics', async (context) => {
  await context.test('cancellation', () => {
    const job = completeCancelledVideoJob()
    const cancellation = job.cancellation as Record<string, unknown>
    assert.equal(isGenerationJob({
      ...job,
      cancellation: { ...cancellation, upstreamCancellation: 'provider-accepted' },
    }), false)
  })

  await context.test('providerDiagnostic', () => {
    const job = completeResolvedVideoJob()
    const providerDiagnostic = job.providerDiagnostic as Record<string, unknown>
    assert.equal(isGenerationJob({
      ...job,
      providerDiagnostic: { ...providerDiagnostic, protocol: 'future-protocol' },
    }), false)
  })

  await context.test('unknownSubmissionResolution', () => {
    const job = completeResolvedVideoJob()
    const resolution = job.unknownSubmissionResolution as Record<string, unknown>
    assert.equal(isGenerationJob({
      ...job,
      unknownSubmissionResolution: { ...resolution, jobId: 'job-from-another-audit' },
    }), false)
  })
})

test('generationJobFromEventData accepts direct and wrapped Jobs but rejects malformed event data', () => {
  const job = completeResolvedVideoJob()
  assert.equal(generationJobFromEventData(job), job)
  assert.equal(generationJobFromEventData({ job }), job)

  const malformed = { ...job, retryDisposition: 'retry-without-confirmation' }
  assert.equal(generationJobFromEventData(malformed), null)
  assert.equal(generationJobFromEventData({ job: malformed }), null)
  assert.equal(generationJobFromEventData({ job: 'not-an-object' }), null)
  assert.equal(generationJobFromEventData(null), null)
})

test('listGenerationJobs rejects a snapshot containing one malformed Job', async () => {
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  const malformed = {
    ...completeResolvedVideoJob(),
    retryDisposition: 'retry-without-confirmation',
  }
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input)
    return new Response(JSON.stringify({
      jobs: [completeResolvedVideoJob(), malformed],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await assert.rejects(
      listGenerationJobs({ projectId: 'project-1', limit: 200 }),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
    assert.equal(requestedUrl, '/api/v1/jobs?projectId=project-1&limit=200')
  } finally {
    globalThis.fetch = originalFetch
  }
})
