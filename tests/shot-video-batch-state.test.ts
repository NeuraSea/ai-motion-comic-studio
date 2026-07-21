import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completeShotVideoBatchAttempt,
  clearShotVideoBatchAttemptsForTimingRecovery,
  confirmedShotVideoBatchInput,
  defaultShotVideoBatchSelection,
  initialShotVideoBatchSelection,
  parseShotVideoReferenceCompatibilityIssues,
  prepareShotVideoBatchAttempt,
  referencesFromShotVideoDraft,
  shotVideoAudioPolicy,
  shotVideoBatchConfigurationKey,
  shotVideoBatchPreflightMatches,
  shotVideoTimingRemediationFocusLineId,
  shotVideoTimingRemediationFocusTarget,
  shotVideoTimingRepreflightRecovery,
  shotVideoVisualAnalysisBlocksPreflight,
  shotVideoVisualAnalysisAuthorityKey,
  shotVideoVisualAnalysisShotKey,
  shotVideoVisualAnalysisTargets,
  summarizeShotVideoBatchAvailability,
  validShotVideoVisualAnalysisJobId,
  wholeTurnaroundCompatibilityRecoveryReferences,
} from '../src/features/video/shot-video-batch-state'
import type {
  ShotVideoBatchPreflight,
  ShotVideoBatchPreflightInput,
  ShotVideoTimingRemediation,
} from '../src/lib'

const input: ShotVideoBatchPreflightInput = {
  projectId: 'project-1',
  providerId: 'seedance-video',
  resolution: '720p',
  selections: [{
    shotId: 'shot-1',
    sceneId: 'scene-1',
    durationSeconds: 5,
    references: [
      { assetId: 'asset-first', role: 'first_frame' },
      { assetId: 'asset-last', role: 'last_frame' },
    ],
  }],
}

const preflight: ShotVideoBatchPreflight = {
  version: 1,
  projectId: 'project-1',
  episodeId: 'episode-1',
  sourceRevisionId: 'revision-1',
  resolution: '720p',
  publicationMode: 'replace_current',
  audioPolicy: 'silent',
  generateAudio: false,
  provider: {
    providerId: 'seedance-video',
    configRevision: 2,
    model: 'doubao-seedance-2-0-260128',
  },
  billableTaskCount: 1,
  totalRequestedSeconds: 5,
  priceEstimate: null,
  priceEstimateReason: 'PROVIDER_PRICING_UNAVAILABLE',
  targets: [{
    shotId: 'shot-1',
    sceneId: 'scene-1',
    durationSeconds: 5,
    timelineDurationSeconds: 5,
    durationDecision: {
      version: 1,
      source: 'manual_override',
      frameRate: 24,
      plannedDurationSeconds: 5,
      speechDurationSeconds: null,
      timelineDurationSeconds: 5,
      providerDurationSeconds: 5,
      speechBindings: [],
      notices: [],
    },
    referenceMode: 'first-last-frame',
    references: [
      { assetId: 'asset-first', role: 'first_frame', version: 1, checksum: 'a'.repeat(64), sourceRevisionId: 'revision-1' },
      { assetId: 'asset-last', role: 'last_frame', version: 1, checksum: 'b'.repeat(64), sourceRevisionId: 'revision-1' },
    ],
    referenceDecision: {
      version: 1,
      source: 'manual_override',
      storyboardAnchorAssetId: null,
      selectedReferences: [
        { assetId: 'asset-first', role: 'first_frame' },
        { assetId: 'asset-last', role: 'last_frame' },
      ],
      recommendation: {
        version: 1,
        policy: 'deterministic-character-view-v1',
        status: 'not_applicable',
        shotId: 'shot-1',
        sceneId: 'scene-1',
        sourceRevisionId: 'revision-1',
        confidence: null,
        rationale: '镜头未明确关联角色。',
        characters: [],
        references: [],
      },
    },
    promptPreview: '镜头：远景，固定镜头。第一盏灯亮起。',
    promptCompilerVersion: 'seedance-compact-v1',
    promptCompilerNotices: [],
  }],
  expiresAt: '2100-01-01T00:00:00.000Z',
  confirmationToken: `svpf1_4102444800_${'a'.repeat(64)}`,
}

test('Seedance reference diagnostics retain exact shot, slot dimensions, and safe turnaround replacement', () => {
  const parsed = parseShotVideoReferenceCompatibilityIssues({
    version: 1,
    issues: [{
      shotId: 'shot-3',
      sceneId: 'scene-1',
      assetId: 'asset-back',
      role: 'reference_image',
      kind: 'character-reference.back',
      width: 408,
      height: 1_024,
      aspectRatio: 0.3984375,
      character: { id: 'character-ali', name: '阿离', view: 'back' },
      turnaroundSource: { assetId: 'asset-turnaround', width: 1_536, height: 1_024, aspectRatio: 1.5 },
    }],
  })
  assert.deepEqual(parsed, [{
    shotId: 'shot-3',
    sceneId: 'scene-1',
    assetId: 'asset-back',
    role: 'reference_image',
    kind: 'character-reference.back',
    width: 408,
    height: 1_024,
    aspectRatio: 0.3984375,
    character: { id: 'character-ali', name: '阿离', view: 'back' },
    turnaroundSource: { assetId: 'asset-turnaround', width: 1_536, height: 1_024, aspectRatio: 1.5 },
  }])
  assert.deepEqual(parseShotVideoReferenceCompatibilityIssues({ version: 1, issues: [{ assetId: 'leak' }] }), [])
})

function timingRemediation(): ShotVideoTimingRemediation {
  const previousDecision = {
    version: 1 as const,
    source: 'speech_assets' as const,
    frameRate: 24 as const,
    plannedDurationSeconds: 5,
    speechDurationSeconds: 2,
    timelineDurationSeconds: 2,
    providerDurationSeconds: 4,
    speechBindings: [{
      dialogueLineId: 'line-1',
      assetId: 'speech-old',
      version: 1,
      checksum: 'a'.repeat(64),
      durationSeconds: 2,
      durationFrames: 48,
    }],
    notices: ['AUDIO_DRIVEN_TIMELINE' as const],
  }
  return {
    version: 1,
    kind: 'stale_audio_timing',
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotId: 'shot-1',
    sceneId: 'scene-1',
    sourceRevisionId: 'revision-1',
    checkpoint: 'pre-submit',
    providerSubmissionState: 'not-started',
    detectedAt: '2026-07-15T02:00:00.000Z',
    previousDecision,
    currentResolution: {
      status: 'audio_required',
      shotId: 'shot-1',
      blockedLines: [{ dialogueLineId: 'line-new', reason: 'SPEECH_ASSET_MISSING' }],
    },
    affectedLines: [{
      dialogueLineId: 'line-1',
      change: 'removed',
      previous: {
        assetId: 'speech-old',
        version: 1,
        checksum: 'a'.repeat(64),
        durationSeconds: 2,
        durationFrames: 48,
      },
      current: null,
    }],
    recommendedAction: 'regenerate-speech-or-repreflight',
  }
}

test('reference drafts preserve mutually exclusive first/last and multi-reference modes', () => {
  assert.deepEqual(referencesFromShotVideoDraft({
    mode: 'frames',
    firstFrameAssetId: 'asset-first',
    lastFrameAssetId: 'asset-last',
  }), {
    references: [
      { assetId: 'asset-first', role: 'first_frame' },
      { assetId: 'asset-last', role: 'last_frame' },
    ],
    issues: [],
  })
  assert.match(referencesFromShotVideoDraft({
    mode: 'frames',
    firstFrameAssetId: null,
    lastFrameAssetId: 'asset-last',
  }).issues[0], /首帧/)
  assert.match(referencesFromShotVideoDraft({
    mode: 'multi-reference',
    assetIds: ['asset-a', 'asset-a'],
  }).issues.join('；'), /重复/)
  assert.match(referencesFromShotVideoDraft({
    mode: 'multi-reference',
    assetIds: ['stale-asset'],
  }, new Set(['asset-current'])).issues.join('；'), /失效/)
})

test('whole-turnaround recovery preserves the current storyboard as a multi-reference content anchor', () => {
  const eligible = new Set(['storyboard-current', 'turnaround-whole'])
  assert.deepEqual(wholeTurnaroundCompatibilityRecoveryReferences({
    storyboardAssetId: 'storyboard-current',
    turnaroundAssetId: 'turnaround-whole',
  }, eligible), [
    { assetId: 'storyboard-current', role: 'reference_image' },
    { assetId: 'turnaround-whole', role: 'reference_image' },
  ])
  assert.deepEqual(wholeTurnaroundCompatibilityRecoveryReferences({
    storyboardAssetId: null,
    turnaroundAssetId: 'turnaround-whole',
  }, eligible), [
    { assetId: 'turnaround-whole', role: 'reference_image' },
  ])
  assert.deepEqual(wholeTurnaroundCompatibilityRecoveryReferences({
    storyboardAssetId: 'storyboard-current',
    turnaroundAssetId: 'turnaround-stale',
  }, eligible), [])
})

test('audio policy keeps SFX-only distinct from unrestricted provider audio', () => {
  assert.equal(shotVideoAudioPolicy({ audioPolicy: 'sfx_only' }), 'sfx_only')
  assert.equal(shotVideoAudioPolicy({ generateAudio: true }), 'provider_audio')
  assert.equal(shotVideoAudioPolicy({ generateAudio: false }), 'silent')
  assert.equal(shotVideoBatchPreflightMatches(preflight, 'episode-1', 'revision-1', {
    ...input,
    audioPolicy: 'sfx_only',
  }), false)
})

test('confirmation is invalidated by revision, target, role, or duration drift', () => {
  assert.equal(shotVideoBatchPreflightMatches(preflight, 'episode-1', 'revision-1', input), true)
  assert.equal(shotVideoBatchPreflightMatches(preflight, 'episode-1', 'revision-2', input), false)
  assert.equal(shotVideoBatchPreflightMatches(preflight, 'episode-1', 'revision-1', {
    ...input,
    selections: [{ ...input.selections[0], durationSeconds: 6 }],
  }), false)
  assert.equal(shotVideoBatchPreflightMatches(preflight, 'episode-1', 'revision-1', {
    ...input,
    generateAudio: true,
  }), false)
  assert.equal(shotVideoBatchPreflightMatches(preflight, 'episode-1', 'revision-1', {
    ...input,
    selections: [{
      ...input.selections[0],
      references: [{ assetId: 'asset-first', role: 'reference_image' }],
    }],
  }), false)
  assert.deepEqual(
    confirmedShotVideoBatchInput(preflight, 'episode-1', 'revision-1', input),
    { ...input, confirmationToken: preflight.confirmationToken },
  )
})

test('ambiguous batch submissions retain one root Idempotency-Key until acknowledged', () => {
  const attempts = new Map<string, string>()
  let sequence = 0
  const first = prepareShotVideoBatchAttempt(attempts, 'episode-1', input, () => `batch-${++sequence}`)
  const retry = prepareShotVideoBatchAttempt(attempts, 'episode-1', input, () => `batch-${++sequence}`)
  assert.equal(retry.idempotencyKey, first.idempotencyKey)
  completeShotVideoBatchAttempt(attempts, { ...first, idempotencyKey: 'wrong-key' })
  assert.equal(attempts.size, 1)
  completeShotVideoBatchAttempt(attempts, first)
  assert.equal(attempts.size, 0)
})

test('Prompt strategy has an independent retry lease and preflight authority', () => {
  const compact: ShotVideoBatchPreflightInput = {
    ...input,
    promptCompilerVersion: 'seedance-compact-v1',
  }
  const baseline: ShotVideoBatchPreflightInput = {
    ...compact,
    promptCompilerVersion: 'seedance-verbose-baseline-v1',
  }
  assert.notEqual(
    shotVideoBatchConfigurationKey('episode-1', compact),
    shotVideoBatchConfigurationKey('episode-1', baseline),
  )
  assert.equal(shotVideoBatchPreflightMatches(
    preflight,
    'episode-1',
    'revision-1',
    compact,
  ), true)
  assert.equal(shotVideoBatchPreflightMatches(
    preflight,
    'episode-1',
    'revision-1',
    baseline,
  ), false)
})

test('publication mode has an independent retry lease and preflight authority', () => {
  const production: ShotVideoBatchPreflightInput = {
    ...input,
    promptCompilerVersion: 'seedance-compact-v1',
    publicationMode: 'replace_current',
  }
  const audition: ShotVideoBatchPreflightInput = {
    ...production,
    publicationMode: 'evaluation_only',
  }
  assert.notEqual(
    shotVideoBatchConfigurationKey('episode-1', production),
    shotVideoBatchConfigurationKey('episode-1', audition),
  )
  assert.equal(shotVideoBatchPreflightMatches(
    preflight,
    'episode-1',
    'revision-1',
    production,
  ), true)
  assert.equal(shotVideoBatchPreflightMatches(
    preflight,
    'episode-1',
    'revision-1',
    audition,
  ), false)
})

test('audio timing recovery clears only the exact single-shot root lease', () => {
  const attempts = new Map<string, string>()
  const exactInput: ShotVideoBatchPreflightInput = {
    projectId: 'project-1',
    selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
  }
  const otherScene: ShotVideoBatchPreflightInput = {
    ...exactInput,
    selections: [{ shotId: 'shot-1', sceneId: 'scene-other' }],
  }
  const legacySceneLess: ShotVideoBatchPreflightInput = {
    ...exactInput,
    selections: [{ shotId: 'shot-1' }],
  }
  const multiShot: ShotVideoBatchPreflightInput = {
    ...exactInput,
    selections: [
      { shotId: 'shot-1', sceneId: 'scene-1' },
      { shotId: 'shot-2', sceneId: 'scene-1' },
    ],
  }
  const otherShot: ShotVideoBatchPreflightInput = {
    ...exactInput,
    selections: [{ shotId: 'shot-2', sceneId: 'scene-1' }],
  }
  const exactKey = shotVideoBatchConfigurationKey('episode-1', exactInput)
  const otherSceneKey = shotVideoBatchConfigurationKey('episode-1', otherScene)
  const legacySceneLessKey = shotVideoBatchConfigurationKey('episode-1', legacySceneLess)
  const multiKey = shotVideoBatchConfigurationKey('episode-1', multiShot)
  const otherShotKey = shotVideoBatchConfigurationKey('episode-1', otherShot)
  const otherEpisodeKey = shotVideoBatchConfigurationKey('episode-2', exactInput)
  attempts.set(exactKey, 'remove-me')
  attempts.set(otherSceneKey, 'keep-scene')
  attempts.set(legacySceneLessKey, 'remove-legacy-scene')
  attempts.set(multiKey, 'keep-multi')
  attempts.set(otherShotKey, 'keep-shot')
  attempts.set(otherEpisodeKey, 'keep-episode')
  attempts.set('legacy-unparseable-key', 'keep-unknown')

  assert.equal(clearShotVideoBatchAttemptsForTimingRecovery(attempts, {
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotId: 'shot-1',
    sceneId: 'scene-1',
  }), 2)
  assert.equal(attempts.has(exactKey), false)
  assert.equal(attempts.has(legacySceneLessKey), false)
  assert.deepEqual([...attempts.values()].sort(), [
    'keep-episode',
    'keep-multi',
    'keep-scene',
    'keep-shot',
    'keep-unknown',
  ])
})

test('timing remediation handoff preserves exact scope and focuses authoritative line evidence', () => {
  const remediation = timingRemediation()
  assert.deepEqual(shotVideoTimingRepreflightRecovery('job-stale-1', remediation), {
    version: 1,
    reason: 'stale_audio_timing',
    sourceJobId: 'job-stale-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    shotId: 'shot-1',
    sceneId: 'scene-1',
    sourceRevisionId: 'revision-1',
    detectedAt: '2026-07-15T02:00:00.000Z',
    providerSubmissionState: 'not-started',
  })
  assert.equal(shotVideoTimingRemediationFocusLineId(remediation), 'line-1')
  assert.deepEqual(shotVideoTimingRemediationFocusTarget(remediation), {
    sceneId: 'scene-1',
    shotId: 'shot-1',
    dialogueLineId: 'line-1',
  })
  assert.equal(shotVideoTimingRemediationFocusLineId({
    ...remediation,
    affectedLines: [],
  }), 'line-new')
  assert.deepEqual(shotVideoTimingRemediationFocusTarget({
    ...remediation,
    sceneId: 'scene-duplicate-id-scope',
    shotId: 'shot-duplicate-id',
    affectedLines: [],
  }), {
    sceneId: 'scene-duplicate-id-scope',
    shotId: 'shot-duplicate-id',
    dialogueLineId: 'line-new',
  })
})

test('Agentic omission and explicit manual text-only override have distinct durable identities', () => {
  const automatic: ShotVideoBatchPreflightInput = {
    projectId: 'project-1',
    selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
  }
  const manual: ShotVideoBatchPreflightInput = {
    projectId: 'project-1',
    selections: [{ shotId: 'shot-1', sceneId: 'scene-1', references: [] }],
  }
  assert.notEqual(
    shotVideoBatchConfigurationKey('episode-1', automatic),
    shotVideoBatchConfigurationKey('episode-1', manual),
  )
})

test('visual analysis authority invalidates Job ID on selection, revision, checksum, or text Provider drift', () => {
  const authority = {
    sourceRevisionId: 'revision-1',
    selections: [
      { shotId: 'shot-2', sceneId: 'scene-1' },
      { shotId: 'shot-1', sceneId: 'scene-1' },
    ],
    assets: [
      { id: 'asset-b', version: 1, checksum: 'b'.repeat(64) },
      { id: 'asset-a', version: 2, checksum: 'a'.repeat(64) },
    ],
    textProviderId: 'text-provider',
    textProviderConfigRevision: 7,
    textProviderModel: 'vision-model',
    textProviderReady: true,
  }
  const key = shotVideoVisualAnalysisAuthorityKey(authority)
  assert.equal(key, shotVideoVisualAnalysisAuthorityKey({
    ...authority,
    selections: [...authority.selections].reverse(),
    assets: [...authority.assets].reverse(),
  }))
  assert.equal(validShotVideoVisualAnalysisJobId({
    jobId: 'vision-job',
    jobStatus: 'succeeded',
    jobAuthorityKey: key,
    currentAuthorityKey: key,
  }), 'vision-job')
  assert.equal(validShotVideoVisualAnalysisJobId({
    jobId: 'vision-job',
    jobStatus: 'running',
    jobAuthorityKey: key,
    currentAuthorityKey: key,
  }), null)
  for (const changed of [
    { ...authority, sourceRevisionId: 'revision-2' },
    { ...authority, selections: authority.selections.slice(0, 1) },
    { ...authority, assets: [{ ...authority.assets[0], checksum: 'c'.repeat(64) }, authority.assets[1]] },
    { ...authority, textProviderConfigRevision: 8 },
  ]) {
    const changedKey = shotVideoVisualAnalysisAuthorityKey(changed)
    assert.notEqual(changedKey, key)
    assert.equal(validShotVideoVisualAnalysisJobId({
      jobId: 'vision-job',
      jobStatus: 'succeeded',
      jobAuthorityKey: key,
      currentAuthorityKey: changedKey,
    }), null)
  }
})

test('visual-analysis browser state uses the full scene and shot scope', () => {
  assert.equal(
    shotVideoVisualAnalysisShotKey({ sceneId: 'scene-a', shotId: 'shared-shot' }),
    JSON.stringify(['scene-a', 'shared-shot']),
  )
  assert.notEqual(
    shotVideoVisualAnalysisShotKey({ sceneId: 'scene-a', shotId: 'shared-shot' }),
    shotVideoVisualAnalysisShotKey({ sceneId: 'scene-b', shotId: 'shared-shot' }),
    'same public shot ID in another scene must never overwrite its binding',
  )
})

test('visual analysis Job identity is part of free preflight and paid confirmation configuration', () => {
  const withFirstJob = {
    ...input,
    referenceAnalysisJobId: 'vision-job-1',
    selections: [{ shotId: 'shot-1', sceneId: 'scene-1' }],
  }
  const withSecondJob = { ...withFirstJob, referenceAnalysisJobId: 'vision-job-2' }
  assert.notEqual(
    shotVideoBatchConfigurationKey('episode-1', withFirstJob),
    shotVideoBatchConfigurationKey('episode-1', withSecondJob),
  )

  const visionPreflight: ShotVideoBatchPreflight = {
    ...preflight,
    targets: [{
      ...preflight.targets[0],
      referenceDecision: {
        ...preflight.targets[0].referenceDecision,
        source: 'agentic_auto',
        automaticPolicy: 'persisted_vision',
        visionAnalysisJobId: 'vision-job-1',
      },
    }],
  }
  assert.equal(
    shotVideoBatchPreflightMatches(visionPreflight, 'episode-1', 'revision-1', withFirstJob),
    true,
  )
  assert.equal(
    shotVideoBatchPreflightMatches(visionPreflight, 'episode-1', 'revision-1', withSecondJob),
    false,
  )

  const perShotJob: ShotVideoBatchPreflightInput = {
    ...input,
    selections: [{
      shotId: 'shot-1',
      sceneId: 'scene-1',
      referenceAnalysisJobId: 'vision-job-1',
    }],
  }
  assert.equal(
    shotVideoBatchPreflightMatches(visionPreflight, 'episode-1', 'revision-1', perShotJob),
    true,
  )
  assert.equal(
    shotVideoBatchPreflightMatches(visionPreflight, 'episode-1', 'revision-1', {
      ...perShotJob,
      selections: [{ ...perShotJob.selections[0], referenceAnalysisJobId: 'vision-job-2' }],
    }),
    false,
  )
})

test('a running visual Job blocks only smart preflight and never locks manual overrides', () => {
  assert.equal(shotVideoVisualAnalysisBlocksPreflight('smart', true), true)
  assert.equal(shotVideoVisualAnalysisBlocksPreflight('manual', true), false)
  assert.equal(shotVideoVisualAnalysisBlocksPreflight('smart', false), false)
})

test('deep visual analysis is scoped to one shot or only preflight-reported ambiguities', () => {
  const shots = [
    { shotId: 'shot-1', sceneId: 'scene-1' },
    { shotId: 'shot-2', sceneId: 'scene-1' },
    { shotId: 'shot-3', sceneId: 'scene-2' },
  ]
  assert.deepEqual(
    shotVideoVisualAnalysisTargets(shots, new Set()),
    [],
    'a full batch must use the fast deterministic preflight first',
  )
  assert.deepEqual(
    shotVideoVisualAnalysisTargets(shots.slice(0, 1), new Set()),
    [shots[0]],
  )
  assert.deepEqual(
    shotVideoVisualAnalysisTargets(shots, new Set(['shot-2', 'shot-3'])),
    [shots[1], shots[2]],
  )
})

test('per-shot visual Job identity changes only that selection configuration', () => {
  const deterministic: ShotVideoBatchPreflightInput = {
    projectId: 'project-1',
    selections: [
      { shotId: 'shot-1', sceneId: 'scene-1' },
      { shotId: 'shot-2', sceneId: 'scene-1' },
    ],
  }
  const targeted: ShotVideoBatchPreflightInput = {
    ...deterministic,
    selections: [
      { ...deterministic.selections[0], referenceAnalysisJobId: 'vision-job-1' },
      deterministic.selections[1]!,
    ],
  }
  assert.notEqual(
    shotVideoBatchConfigurationKey('episode-1', deterministic),
    shotVideoBatchConfigurationKey('episode-1', targeted),
  )
  const legacyShape = JSON.parse(
    shotVideoBatchConfigurationKey('episode-1', deterministic),
  ) as { selections: Array<Record<string, unknown>> }
  assert.equal(
    Object.hasOwn(legacyShape.selections[0]!, 'referenceAnalysisJobId'),
    false,
    'an absent per-shot Job must not rewrite the pre-existing configuration identity',
  )
})

test('batch defaults select every pending shot while generated versions require explicit regeneration and safety locks stay excluded', () => {
  const shots = [
    { shotId: 'shot-generated-a', videoState: 'generated' as const },
    { shotId: 'shot-pending-a', videoState: 'pending' as const },
    { shotId: 'shot-unknown-locked', videoState: 'locked' as const },
    { shotId: 'shot-pending-b', videoState: 'pending' as const },
    { shotId: 'shot-generated-b', videoState: 'generated' as const },
  ]
  assert.deepEqual(defaultShotVideoBatchSelection(shots), ['shot-pending-a', 'shot-pending-b'])
  assert.deepEqual(
    initialShotVideoBatchSelection(shots, 'shot-generated-a'),
    ['shot-generated-a'],
  )
  assert.deepEqual(
    initialShotVideoBatchSelection(shots, 'shot-unknown-locked'),
    ['shot-pending-a', 'shot-pending-b'],
  )
  assert.deepEqual(
    initialShotVideoBatchSelection(shots, 'missing-shot'),
    ['shot-pending-a', 'shot-pending-b'],
  )
  assert.deepEqual(summarizeShotVideoBatchAvailability(shots), {
    pending: 2,
    generated: 2,
    locked: 1,
  })
})
