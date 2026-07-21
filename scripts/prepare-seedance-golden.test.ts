import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  parseSeedanceGoldenPair,
  prepareSeedanceGoldenDraft,
  inspectSeedanceGoldenCandidates,
  SeedanceGoldenPreparationError,
  type SeedanceGoldenJobPair,
} from './prepare-seedance-golden.js'
import {
  finalizeSeedanceGoldenManifest,
  SeedanceGoldenFinalizationError,
} from './finalize-seedance-golden.js'
import { SEEDANCE_GOLDEN_METRICS } from './verify-seedance-golden.js'

const EPISODE_ID = 'episode-golden'
const PROJECT_ID = 'project-golden'
const REVISION_ID = 'revision-current'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fixture(options: { comparisonAxis?: 'resolution' | 'prompt_strategy' } = {}): Promise<{
  directory: string
  databasePath: string
  pairs: SeedanceGoldenJobPair[]
}> {
  const comparisonAxis = options.comparisonAxis ?? 'resolution'
  const directory = await mkdtemp(join(tmpdir(), 'manju-seedance-golden-preparer-'))
  const databasePath = join(directory, 'manju.sqlite')
  const mediaDirectory = join(directory, 'media')
  await mkdir(mediaDirectory)
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE episodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_revision_id TEXT
    ) STRICT;
    CREATE TABLE scenes (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE shots (
      id TEXT PRIMARY KEY,
      scene_id TEXT NOT NULL,
      source_revision_id TEXT
    ) STRICT;
    CREATE TABLE dialogue_lines (
      id TEXT PRIMARY KEY,
      shot_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      speech_asset_id TEXT
    ) STRICT;
    CREATE TABLE generation_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      episode_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_id TEXT,
      model TEXT,
      provider_config_revision INTEGER,
      external_task_id TEXT,
      input_json TEXT NOT NULL,
      output_json TEXT,
      started_at TEXT,
      completed_at TEXT
    ) STRICT;
    CREATE TABLE media_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      episode_id TEXT,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      file_path TEXT,
      mime_type TEXT,
      duration_seconds REAL,
      checksum TEXT,
      generation_job_id TEXT,
      source_revision_id TEXT
    ) STRICT;
  `)
  database.prepare('INSERT INTO episodes VALUES (?, ?, ?)').run(EPISODE_ID, PROJECT_ID, REVISION_ID)
  const pairs: SeedanceGoldenJobPair[] = []
  const referenceBytes = Buffer.from('real-reference-image')
  const referenceChecksum = sha256(referenceBytes)
  await writeFile(join(mediaDirectory, 'reference.png'), referenceBytes)
  database.prepare(`INSERT INTO media_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('reference-current', PROJECT_ID, EPISODE_ID, 'storyboard.image', 3, 'ready', 'media/reference.png', 'image/png', null, referenceChecksum, null, REVISION_ID)

  for (let index = 0; index < 6; index += 1) {
    const sceneId = `scene-${index}`
    const shotId = `shot-${index}`
    const databaseShotId = `database-shot-${index}`
    const lineId = `line-${index}`
    const speechId = `speech-${index}`
    const speechDuration = 4.25 + index / 10
    const speechChecksum = sha256(Buffer.from(`speech-${index}`))
    database.prepare('INSERT INTO scenes VALUES (?, ?)').run(sceneId, EPISODE_ID)
    database.prepare('INSERT INTO shots VALUES (?, ?, ?)').run(databaseShotId, sceneId, REVISION_ID)
    database.prepare(`INSERT INTO media_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(speechId, PROJECT_ID, EPISODE_ID, 'dialogue.audio', 1, 'ready', null, 'audio/wav', speechDuration, speechChecksum, null, REVISION_ID)
    database.prepare('INSERT INTO dialogue_lines VALUES (?, ?, ?, ?, ?)')
      .run(`database-line-${index}`, databaseShotId, 0, JSON.stringify({ storyId: lineId }), speechId)

    const durationDecision = {
      version: 1,
      source: 'speech_assets',
      frameRate: 24,
      plannedDurationSeconds: 5,
      speechDurationSeconds: Math.ceil(speechDuration * 24) / 24,
      timelineDurationSeconds: Math.ceil(speechDuration * 24) / 24,
      providerDurationSeconds: 5,
      speechBindings: [{
        dialogueLineId: lineId,
        assetId: speechId,
        version: 1,
        checksum: speechChecksum,
        durationSeconds: speechDuration,
        durationFrames: Math.ceil(speechDuration * 24),
      }],
      notices: ['AUDIO_DRIVEN_TIMELINE'],
    }
    const references = [{
      assetId: 'reference-current',
      role: 'first_frame',
      version: 3,
      checksum: referenceChecksum,
      sourceRevisionId: REVISION_ID,
    }]
    for (const role of ['candidate', 'baseline'] as const) {
      const jobId = `${role}-job-${index}`
      const assetId = `${role}-asset-${index}`
      const resolution = comparisonAxis === 'resolution' && role === 'baseline' ? '1080p' : '720p'
      const promptCompilerVersion = comparisonAxis === 'prompt_strategy' && role === 'baseline'
        ? 'seedance-verbose-baseline-v1'
        : 'seedance-compact-v1'
      const prompt = comparisonAxis === 'prompt_strategy' && role === 'baseline'
        ? `视频任务：镜头 ${index}。主体动作：角色向前行走。连续性要求：保持角色身份和场景稳定。`
        : `镜头 ${index}，角色向前行走。`
      const videoBytes = Buffer.from(`${role}-real-provider-video-${index}`)
      const videoChecksum = sha256(videoBytes)
      await writeFile(join(mediaDirectory, `${assetId}.mp4`), videoBytes)
      const input = {
        prompt,
        aspectRatio: '16:9',
        resolution,
        durationSeconds: 5,
        generateAudio: true,
        spec: {
          version: 1,
          promptCompilerVersion,
          subjectNames: ['角色'],
          scene: '山路',
          action: '向前行走',
          shotSize: '中景',
          cameraMovement: '静止',
          audioPolicy: 'sfx_only',
          durationSeconds: 5,
          resolution,
          aspectRatio: '16:9',
          sourceRevisionId: REVISION_ID,
          references: [{ assetId: 'reference-current', role: 'first_frame' }],
        },
        binding: {
          episodeId: EPISODE_ID,
          shotId,
          sceneId,
          databaseShotId,
          expectedRevisionId: REVISION_ID,
          expectedPreviousVideoAssetId: null,
        },
        references,
        durationDecision,
      }
      const taskId = `${role}-task-${index}`
      const output = {
        asset: {
          id: assetId,
          url: `/api/v1/assets/${assetId}/content`,
          mimeType: 'video/mp4',
          width: resolution === '720p' ? 1280 : 1920,
          height: resolution === '720p' ? 720 : 1080,
          durationSeconds: 5.01,
        },
        shotId,
        externalTaskId: taskId,
      }
      database.prepare(`INSERT INTO generation_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(jobId, PROJECT_ID, EPISODE_ID, 'shot.video.generate', 'succeeded', 'seedance', 'doubao-seedance-2-0', 7, taskId, JSON.stringify(input), JSON.stringify(output), `2026-07-15T00:0${index}:00.000Z`, `2026-07-15T00:0${index}:10.000Z`)
      database.prepare(`INSERT INTO media_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(assetId, PROJECT_ID, EPISODE_ID, 'shot.video', 1, 'ready', `media/${assetId}.mp4`, 'video/mp4', 5.01, videoChecksum, jobId, REVISION_ID)
    }
    pairs.push({ candidateJobId: `candidate-job-${index}`, baselineJobId: `baseline-job-${index}` })
  }
  database.close()
  return { directory, databasePath, pairs }
}

test('prepares a fail-closed evidence draft and role-blind review sheet from authoritative bytes', async () => {
  const value = await fixture()
  try {
    const prepared = await prepareSeedanceGoldenDraft({
      databasePath: value.databasePath,
      episodeId: EPISODE_ID,
      name: 'resolution-golden-v1',
      comparisonAxis: 'resolution',
      pairs: value.pairs,
      now: '2026-07-15T12:00:00.000Z',
      candidateGetsA: (index) => index % 2 === 0,
    })
    assert.equal(prepared.manifest.cases.length, 6)
    assert.equal(prepared.manifest.cases[0]!.variants[0].role, 'candidate')
    assert.equal(prepared.manifest.cases[0]!.variants[0].blindLabel, 'A')
    assert.equal(prepared.manifest.cases[1]!.variants[0].blindLabel, 'B')
    assert.equal(prepared.manifest.cases[0]!.variants[0].review.playbackComplete, false)
    assert.equal(prepared.manifest.cases[0]!.variants[0].review.scores.editability, 0)
    assert.equal(prepared.manifest.cases[0]!.variants[0].providerCost, null)
    assert.equal(prepared.manifest.cases[0]!.variants[0].providerCostEvidence, 'unavailable')
    assert.match(prepared.manifest.cases[0]!.variants[0].timingManifestFingerprint, /^[a-f0-9]{64}$/)
    const blind = prepared.reviewSheet.cases[0]!.variants[0] as Record<string, unknown>
    assert.equal(Object.hasOwn(blind, 'role'), false)
    assert.equal(Object.hasOwn(blind, 'jobId'), false)
    assert.equal(Object.hasOwn(blind, 'providerTaskId'), false)
    assert.match(String(blind.contentUrl), /^\/api\/v1\/assets\//)
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

test('prompt strategy preparation requires the exact reviewed compiler pair and different prompt bytes', async () => {
  const value = await fixture({ comparisonAxis: 'prompt_strategy' })
  try {
    const prepared = await prepareSeedanceGoldenDraft({
      databasePath: value.databasePath,
      episodeId: EPISODE_ID,
      name: 'compact-vs-verbose-golden-v1',
      comparisonAxis: 'prompt_strategy',
      pairs: value.pairs,
      now: '2026-07-16T12:00:00.000Z',
    })
    for (const item of prepared.manifest.cases) {
      const candidate = item.variants.find((entry) => entry.role === 'candidate')!
      const baseline = item.variants.find((entry) => entry.role === 'baseline')!
      assert.equal(candidate.promptCompilerVersion, 'seedance-compact-v1')
      assert.equal(baseline.promptCompilerVersion, 'seedance-verbose-baseline-v1')
      assert.notEqual(candidate.promptChecksum, baseline.promptChecksum)
    }

    const database = new DatabaseSync(value.databasePath)
    const row = database.prepare('SELECT input_json FROM generation_jobs WHERE id = ?').get('baseline-job-0') as { input_json: string }
    const input = JSON.parse(row.input_json) as { spec: { promptCompilerVersion: string } }
    input.spec.promptCompilerVersion = 'manual-long-prompt-v1'
    database.prepare('UPDATE generation_jobs SET input_json = ? WHERE id = ?').run(JSON.stringify(input), 'baseline-job-0')
    database.close()
    await assert.rejects(
      prepareSeedanceGoldenDraft({
        databasePath: value.databasePath,
        episodeId: EPISODE_ID,
        name: 'wrong-baseline-golden-v1',
        comparisonAxis: 'prompt_strategy',
        pairs: value.pairs,
      }),
      (error: unknown) => error instanceof SeedanceGoldenPreparationError
        && /baseline 必须使用 seedance-verbose-baseline-v1/.test(error.message),
    )
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

test('inspection lists only current byte-verified audio-first candidates without Provider calls', async () => {
  const value = await fixture()
  try {
    const inspected = await inspectSeedanceGoldenCandidates({
      databasePath: value.databasePath,
      episodeId: EPISODE_ID,
    })
    assert.equal(inspected.eligible.length, 12)
    assert.equal(inspected.rejected.length, 0)
    assert.equal(inspected.providerSubmissions, 0)
    assert.equal(new Set(inspected.eligible.map((item) => item.shotId)).size, 6)
    assert.ok(inspected.eligible.every((item) => item.timingManifestFingerprint.match(/^[a-f0-9]{64}$/)))
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

test('rejects a current Episode whose selected Job is bound to an old Story revision', async () => {
  const value = await fixture()
  try {
    const database = new DatabaseSync(value.databasePath)
    const row = database.prepare('SELECT input_json FROM generation_jobs WHERE id = ?').get('candidate-job-0') as { input_json: string }
    const input = JSON.parse(row.input_json) as Record<string, Record<string, unknown>>
    input.binding!.expectedRevisionId = 'revision-old'
    database.prepare('UPDATE generation_jobs SET input_json = ? WHERE id = ?').run(JSON.stringify(input), 'candidate-job-0')
    database.close()
    await assert.rejects(
      prepareSeedanceGoldenDraft({
        databasePath: value.databasePath,
        episodeId: EPISODE_ID,
        name: 'stale-golden',
        comparisonAxis: 'resolution',
        pairs: value.pairs,
      }),
      (error: unknown) => error instanceof SeedanceGoldenPreparationError && /旧 Story revision/.test(error.message),
    )
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

test('rejects output bytes that no longer match the immutable Asset checksum', async () => {
  const value = await fixture()
  try {
    await writeFile(join(value.directory, 'media', 'candidate-asset-0.mp4'), Buffer.from('tampered'))
    await assert.rejects(
      prepareSeedanceGoldenDraft({
        databasePath: value.databasePath,
        episodeId: EPISODE_ID,
        name: 'tampered-golden',
        comparisonAxis: 'resolution',
        pairs: value.pairs,
      }),
      (error: unknown) => error instanceof SeedanceGoldenPreparationError && /本地字节与数据库 checksum 不一致/.test(error.message),
    )
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

test('pair parser is explicit about candidate and baseline identity', () => {
  assert.deepEqual(parseSeedanceGoldenPair('candidate-1,baseline-1'), {
    candidateJobId: 'candidate-1',
    baselineJobId: 'baseline-1',
  })
  assert.throws(() => parseSeedanceGoldenPair('candidate-only'), /candidateJobId,baselineJobId/)
})

test('finalizer merges only completed blind scores and preserves hidden A/B role mapping', async () => {
  const value = await fixture()
  try {
    const prepared = await prepareSeedanceGoldenDraft({
      databasePath: value.databasePath,
      episodeId: EPISODE_ID,
      name: 'blind-resolution-golden',
      comparisonAxis: 'resolution',
      pairs: value.pairs,
      now: '2026-07-15T12:00:00.000Z',
      candidateGetsA: (index) => index % 2 === 0,
    })
    const review = structuredClone(prepared.reviewSheet) as unknown as Record<string, unknown>
    review.reviewerId = 'reviewer-local-1'
    review.reviewedAt = '2026-07-15T13:00:00.000Z'
    for (const item of review.cases as Array<{ variants: Array<Record<string, unknown>> }>) {
      for (const variant of item.variants) {
        variant.playbackComplete = true
        variant.scores = Object.fromEntries(SEEDANCE_GOLDEN_METRICS.map((metric) => [metric, 4]))
        variant.notes = '完整播放，未发现明显退化'
      }
    }
    const finalized = finalizeSeedanceGoldenManifest(prepared.manifest, review)
    assert.equal(finalized.report.passed, true)
    assert.equal(finalized.manifest.cases[0]!.variants[0].role, 'candidate')
    assert.equal(finalized.manifest.cases[0]!.variants[0].blindLabel, 'A')
    assert.equal(finalized.manifest.cases[1]!.variants[0].blindLabel, 'B')
    assert.equal(finalized.manifest.cases[0]!.variants[0].review.reviewerId, 'reviewer-local-1')
    assert.equal(finalized.manifest.cases[0]!.variants[0].review.scores.editability, 4)
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

test('finalizer refuses incomplete playback and direct edits to the role-bearing evidence draft', async () => {
  const value = await fixture()
  try {
    const prepared = await prepareSeedanceGoldenDraft({
      databasePath: value.databasePath,
      episodeId: EPISODE_ID,
      name: 'incomplete-resolution-golden',
      comparisonAxis: 'resolution',
      pairs: value.pairs,
      candidateGetsA: () => true,
    })
    const review = structuredClone(prepared.reviewSheet) as unknown as Record<string, unknown>
    review.reviewerId = 'reviewer-local-1'
    review.reviewedAt = '2026-07-15T13:00:00.000Z'
    assert.throws(
      () => finalizeSeedanceGoldenManifest(prepared.manifest, review),
      (error: unknown) => error instanceof SeedanceGoldenFinalizationError && /尚未确认完整播放/.test(error.message),
    )
    const editedDraft = structuredClone(prepared.manifest) as unknown as Record<string, unknown>
    const editedCases = editedDraft.cases as Array<{ variants: Array<{ review: Record<string, unknown> }> }>
    editedCases[0]!.variants[0]!.review.reviewerId = 'leaked-reviewer'
    const completedReview = structuredClone(review) as Record<string, unknown>
    for (const item of completedReview.cases as Array<{ variants: Array<Record<string, unknown>> }>) {
      for (const variant of item.variants) {
        variant.playbackComplete = true
        variant.scores = Object.fromEntries(SEEDANCE_GOLDEN_METRICS.map((metric) => [metric, 4]))
      }
    }
    assert.throws(
      () => finalizeSeedanceGoldenManifest(editedDraft, completedReview),
      (error: unknown) => error instanceof SeedanceGoldenFinalizationError && /直接编辑/.test(error.message),
    )
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})
