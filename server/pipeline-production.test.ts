import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import {
  createPipelineProductionPorts,
  createPipelineProductionRequestFromDiscovery,
  discoverPipelineProduction,
  PipelineProductionError,
  preparePipelineProduction,
  validatePipelineVoiceCatalog,
  type PipelineProductionAdmissionIdentity,
  type PipelineProductionPortDependencies,
} from './pipeline-production.js'
import type {
  PipelineFanoutSubmission,
  PipelineProviderBinding,
  PipelineRunPorts,
  PinnedPipelineRunOptions,
} from './pipeline-run.js'
import {
  DEFAULT_QUALITY_POLICY,
  type QualityDownloadAuthorization,
} from './quality-check.js'
import { REQUIRED_RELEASE_QUALITY_CHECK_IDS } from './quality-release-policy.js'
import { SQLiteJobRepository } from './repositories.js'
import type { StoryDocument } from './story-schema.js'
import type { StoryCharacterVoiceProfile } from './story-schema.js'
import { StoryRepository } from './story-repository.js'
import {
  SQLiteTimelineDocumentRepository,
  TimelineDocumentError,
  TimelineDocumentService,
  type TimelineDocumentSnapshot,
} from './timeline-documents.js'
import {
  SQLiteTimelineAutoEditRepository,
  TimelineAutoEditService,
  type TimelineAutoEditPlanner,
} from './timeline-auto-edit.js'
import type { JsonObject } from './types.js'
import { PINNED_OPEN_CUT_CLASSIC_COMMIT } from '../apps/opencut-editor/src/opencut-pinned-provenance.js'

const NOW = '2026-07-14T10:00:00.000Z'
const PROJECT_ID = 'production-project'
const EPISODE_ID = 'production-episode'
const PIPELINE_RUN_ID = 'production-pipeline-run'

function story(): StoryDocument {
  return {
    version: 1,
    title: '龙脉初醒',
    targetDurationSeconds: 30,
    bible: {
      logline: '少女在断崖听见龙吟。',
      theme: '责任',
      tone: '紧张',
      visualStyle: '国风动画，电影构图',
    },
    characters: [{
      id: 'hero',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑色长发、红绳、青色圆领袍',
    }, {
      id: 'guardian',
      name: '玄守',
      role: '守门人',
      storyDescription: '沉稳的龙脉守门人',
      visualDescription: '银发、玄甲、身形高大',
    }],
    locations: [{
      id: 'cliff',
      name: '断崖',
      storyDescription: '长安城外',
      visualDescription: '云海与落日',
    }],
    props: [],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '断崖龙吟',
      locationId: 'cliff',
      timeOfDay: '黄昏',
      description: '龙脉苏醒',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `镜头 ${index + 1}`,
        description: '阿离正面面向镜头，在风中看向云海。',
        framing: '中景',
        movement: '缓慢推进',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '国风动画，阿离正面站在断崖黄昏云海前。',
        dialogueLines: index === 0 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue' as const,
          speaker: '阿离',
          text: '它醒了。',
        }, {
          id: 'line-2',
          sequence: 1,
          kind: 'dialogue' as const,
          speaker: '玄守',
          text: '不要靠近龙脉。',
        }] : [],
      })),
    }],
  }
}

const options: PinnedPipelineRunOptions = {
  resolution: '1080p',
  kenBurns: true,
  burnSubtitles: true,
  introTitle: true,
  outroCard: true,
  reviewWatermark: false,
  speechMode: 'auto',
  defaultVoiceId: 'voice-1',
}

interface ProductionFixture {
  database: ManjuDatabase
  stories: StoryRepository
  sourceRevisionId: string
  imageProvider: PipelineProviderBinding
  speechProvider: PipelineProviderBinding
  ports: PipelineRunPorts
  timeline: { current?: TimelineDocumentSnapshot }
  autoEdit: { enabled: boolean; blocked: boolean }
  calls: {
    admissions: PipelineProductionAdmissionIdentity[]
    enqueue: string[]
    cancel: string[]
    materialize: Array<Record<string, unknown>>
    reconcile: Array<Record<string, unknown>>
    autoEditPreview: Array<Record<string, unknown>>
    autoEditApply: Array<Record<string, unknown>>
    exports: Array<Record<string, unknown>>
    quality: Array<Record<string, unknown>>
    authorize: string[]
  }
  setAuthorization(value: QualityDownloadAuthorization): void
}

function fixture(): ProductionFixture {
  let sequence = 0
  const database = initializeDatabase({
    databasePath: ':memory:',
    legacyStatePath: false,
    now: () => NOW,
    idFactory: () => `fixture-${++sequence}`,
  })
  database.createProject({ id: PROJECT_ID, title: 'Production project' })
  const stories = new StoryRepository(database)
  stories.ensureEpisode(PROJECT_ID, {
    id: EPISODE_ID,
    title: '龙脉初醒',
    aspectRatio: '16:9',
    stylePreset: '国风动画',
  })
  const source = database.createRevision({
    id: 'production-story-revision',
    projectId: PROJECT_ID,
    summary: 'Production story',
    snapshot: structuredClone(story()) as unknown as JsonObject,
  })
  stories.applyStory(EPISODE_ID, story(), source.id)
  const visualReferenceAudit = database.createRevision({
    id: 'production-character-views-audit',
    projectId: PROJECT_ID,
    summary: 'Production character view slots',
    snapshot: {
      version: 1,
      kind: 'character.visual-references.lock',
      episodeId: EPISODE_ID,
      sourceRevisionId: source.id,
    },
  })
  const characterRows = database.withSql((sql) => sql.all(`
    SELECT id, json_extract(metadata_json, '$.storyId') AS story_id
      FROM characters
     WHERE project_id = ? AND episode_id = ?
     ORDER BY id
  `, PROJECT_ID, EPISODE_ID))
  for (const character of characterRows) {
    assert.equal(typeof character.id, 'string')
    assert.equal(typeof character.story_id, 'string')
    for (const [index, role] of ['front', 'side', 'back'].entries()) {
      const asset = database.createMediaAsset({
        id: `production-character-${character.story_id as string}-${role}`,
        projectId: PROJECT_ID,
        episodeId: EPISODE_ID,
        kind: `character-turnaround-${role}`,
        version: index + 1,
        status: 'ready',
        filePath: `/durable/${character.story_id as string}-${role}.png`,
        mimeType: 'image/png',
        width: 512,
        height: 512,
        checksum: String(index + 1).repeat(64),
        source: 'fixture-derived-turnaround',
        sourceRevisionId: source.id,
      })
      database.withSql((sql) => sql.run(`
        INSERT INTO character_visual_references (
          character_id, project_id, episode_id, role, asset_id, version,
          audit_revision_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `, character.id as string, PROJECT_ID, EPISODE_ID, role, asset.id, visualReferenceAudit.id, NOW))
    }
  }
  const image = database.createProviderConnection({
    id: 'production-image',
    kind: 'image',
    adapter: 'codex-tools',
    displayName: 'Production image',
    baseUrl: 'http://image.invalid/v1',
    defaultModel: 'gpt-image-1',
    authMode: 'none',
    enabled: true,
  })
  const speech = database.createProviderConnection({
    id: 'production-speech',
    kind: 'speech',
    adapter: 'minimax',
    displayName: 'Production speech',
    baseUrl: 'http://speech.invalid/v1',
    defaultModel: 'speech-2.5-hd-preview',
    authMode: 'none',
    enabled: true,
  })
  database.createPipelineRun({
    id: PIPELINE_RUN_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: source.id,
    idempotencyKey: 'production-parent',
    status: 'running',
    steps: {},
  })

  const calls: ProductionFixture['calls'] = {
    admissions: [],
    enqueue: [],
    cancel: [],
    materialize: [],
    reconcile: [],
    autoEditPreview: [],
    autoEditApply: [],
    exports: [],
    quality: [],
    authorize: [],
  }
  const timeline: ProductionFixture['timeline'] = {}
  const autoEdit: ProductionFixture['autoEdit'] = { enabled: false, blocked: false }
  let authorization: QualityDownloadAuthorization | undefined
  const durableJobs = new SQLiteJobRepository(database, { defaultProjectId: PROJECT_ID, now: () => NOW })

  const materializationResult = (revisionId: string) => ({
    timelineDocument: {
      id: 'timeline-document',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      currentRevisionId: revisionId,
      schemaVersion: 2,
      upstreamCommit: '0'.repeat(40),
      sourceRevisionId: source.id,
      createdAt: NOW,
      updatedAt: NOW,
    },
    revision: {
      id: revisionId,
      documentId: 'timeline-document',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      parentRevisionId: null,
      schemaVersion: 2,
      upstreamCommit: '0'.repeat(40),
      sourceRevisionId: source.id,
      summary: 'fixture',
      snapshot: {},
      createdAt: NOW,
    },
    document: {},
    etag: `"${revisionId}"`,
    created: true,
    report: {},
  })

  const dependencies: PipelineProductionPortDependencies = {
    database,
    stories,
    timelines: {
      get() {
        if (timeline.current) return timeline.current
        const error = new Error('Timeline missing') as Error & { code: string }
        error.code = 'TIMELINE_DOCUMENT_NOT_FOUND'
        throw error
      },
    },
    timelineMaterialization: {
      materialize(input: {
        projectId: string
        episodeId: string
        expectedRevisionId: null
        summary?: string
        autoLayoutManagedDialogue?: boolean
      }) {
        calls.materialize.push(structuredClone(input) as unknown as Record<string, unknown>)
        return materializationResult('timeline-created') as never
      },
      reconcile(input: {
        projectId: string
        episodeId: string
        expectedRevisionId: string
        summary?: string
        autoLayoutManagedDialogue?: boolean
      }) {
        calls.reconcile.push(structuredClone(input) as unknown as Record<string, unknown>)
        return materializationResult('timeline-reconciled') as never
      },
    },
    timelineAutoEdit: {
      preview(input) {
        calls.autoEditPreview.push(structuredClone(input) as unknown as Record<string, unknown>)
        const operation = {
          elementId: 'dialogue-1',
          before: { startTime: 0, duration: 24_000, trimStart: 0 },
          after: { startTime: 24_000, duration: 24_000, trimStart: 0 },
          reason: 'reflow-managed-dialogue-in-story-order',
        }
        return {
          timeline: materializationResult('timeline-created'),
          plan: {
            id: 'auto-edit-plan',
            documentId: 'timeline-document',
            projectId: PROJECT_ID,
            episodeId: EPISODE_ID,
            baseRevisionId: input.expectedRevisionId,
            sourceRevisionId: source.id,
            goal: 'exportable',
            policy: 'safe',
            strategy: 'managed-dialogue-reflow-v1',
            executor: 'OpenCut-Classic/UpdateElementsCommand',
            upstreamCommit: '0'.repeat(40),
            schemaVersion: 2,
            planHash: 'a'.repeat(64),
            risk: autoEdit.blocked ? 'blocked' : 'safe',
            diagnostics: autoEdit.blocked ? [{
              code: 'UNSAFE_AUDIO_OUT_OF_BOUNDS',
              severity: 'error',
              message: '非托管音频越界',
              elementIds: [],
            }] : [],
            operations: autoEdit.enabled ? [operation] : [],
            changedElementIds: autoEdit.enabled ? ['dialogue-1'] : [],
            createdAt: NOW,
            confirmationToken: 'confirmation-token-for-pipeline-test',
          },
          previewDocument: {},
          diagnostics: autoEdit.blocked ? [{
            code: 'UNSAFE_AUDIO_OUT_OF_BOUNDS',
            severity: 'error',
            message: '非托管音频越界',
            elementIds: [],
          }] : [],
          operations: autoEdit.enabled ? [operation] : [],
          risk: autoEdit.blocked ? 'blocked' : 'safe',
          changedElementIds: autoEdit.enabled ? ['dialogue-1'] : [],
        } as never
      },
      apply(input) {
        calls.autoEditApply.push(structuredClone(input) as unknown as Record<string, unknown>)
        const timelineResult = materializationResult('timeline-auto-edited')
        const operation = {
          elementId: 'dialogue-1',
          before: { startTime: 0, duration: 24_000, trimStart: 0 },
          after: { startTime: 24_000, duration: 24_000, trimStart: 0 },
          reason: 'reflow-managed-dialogue-in-story-order',
        }
        return {
          timeline: timelineResult,
          operationResultTimeline: timelineResult,
          headAdvanced: false,
          application: {
            id: 'auto-edit-application',
            planId: 'auto-edit-plan',
            documentId: 'timeline-document',
            projectId: PROJECT_ID,
            episodeId: EPISODE_ID,
            baseRevisionId: input.expectedRevisionId,
            resultRevisionId: 'timeline-auto-edited',
            createdAt: NOW,
          },
          plan: {
            id: 'auto-edit-plan',
            documentId: 'timeline-document',
            projectId: PROJECT_ID,
            episodeId: EPISODE_ID,
            baseRevisionId: input.expectedRevisionId,
            sourceRevisionId: source.id,
            goal: 'exportable',
            policy: 'safe',
            strategy: 'managed-dialogue-reflow-v1',
            executor: 'OpenCut-Classic/UpdateElementsCommand',
            upstreamCommit: '0'.repeat(40),
            schemaVersion: 2,
            planHash: 'a'.repeat(64),
            risk: 'safe',
            diagnostics: [],
            operations: [operation],
            changedElementIds: ['dialogue-1'],
            createdAt: NOW,
          },
          diagnostics: [],
          operations: [operation],
          risk: 'safe',
          changedElementIds: ['dialogue-1'],
          idempotent: false,
        } as never
      },
    },
    exports: {
      create(input) {
        calls.exports.push(structuredClone(input) as unknown as Record<string, unknown>)
        const exportId = `export-${calls.exports.length}`
        const job = database.createGenerationJob({
          projectId: PROJECT_ID,
          episodeId: EPISODE_ID,
          pipelineRunId: input.pipelineRunId ?? null,
          type: 'export.render',
          status: 'queued',
          resourceType: 'renderer:ffmpeg',
          resourceId: exportId,
          idempotencyKey: input.idempotencyKey,
          input: { exportId },
        })
        return { created: true, export: { id: exportId }, job } as never
      },
    },
    qualityChecks: {
      create(input) {
        calls.quality.push(structuredClone(input) as unknown as Record<string, unknown>)
        const reportId = `quality-${calls.quality.length}`
        const outputAssetId = `output-${reportId}`
        const outputAssetChecksum = 'a'.repeat(64)
        const job = database.createGenerationJob({
          projectId: PROJECT_ID,
          episodeId: EPISODE_ID,
          pipelineRunId: input.pipelineRunId ?? null,
          type: 'quality.check',
          status: 'queued',
          resourceType: 'quality.report',
          resourceId: reportId,
          idempotencyKey: input.idempotencyKey,
          input: {
            qualityReportId: reportId,
            exportId: input.exportId,
            outputAssetId,
            outputAssetChecksum,
          },
        })
        return { created: true, report: { id: reportId }, job } as never
      },
      requireDownloadAuthorization(exportId) {
        calls.authorize.push(exportId)
        if (!authorization) throw new Error('authorization fixture missing')
        return authorization
      },
    },
    durableJobs,
    async admitDurableJob(identity, operation) {
      calls.admissions.push(structuredClone(identity))
      return operation()
    },
    worker: {
      enqueue(jobId) {
        calls.enqueue.push(jobId)
      },
      async cancel(jobId) {
        calls.cancel.push(jobId)
        return undefined
      },
    },
  }

  return {
    database,
    stories,
    sourceRevisionId: source.id,
    imageProvider: {
      providerId: image.id,
      configRevision: image.configRevision,
      model: image.defaultModel,
    },
    speechProvider: {
      providerId: speech.id,
      configRevision: speech.configRevision,
      model: speech.defaultModel,
    },
    ports: createPipelineProductionPorts(dependencies),
    timeline,
    autoEdit,
    calls,
    setAuthorization(value) {
      authorization = value
    },
  }
}

function databaseIds(value: ProductionFixture): { shotId: string; lineId: string } {
  const row = value.database.withSql((sql) => sql.get(`
    SELECT shots.id AS shot_id, dialogue_lines.id AS line_id
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
      JOIN dialogue_lines ON dialogue_lines.shot_id = shots.id
     WHERE scenes.episode_id = ? LIMIT 1
  `, EPISODE_ID))
  assert.equal(typeof row?.shot_id, 'string')
  assert.equal(typeof row?.line_id, 'string')
  if (!row) throw new Error('Story database IDs are missing')
  return { shotId: row.shot_id as string, lineId: row.line_id as string }
}

function fanout(
  value: ProductionFixture,
  targetId: string,
  provider: PipelineProviderBinding,
  kind: 'storyboard' | 'speech',
): PipelineFanoutSubmission {
  return {
    pipelineRunId: PIPELINE_RUN_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: value.sourceRevisionId,
    targetId,
    targetIndex: 0,
    idempotencyKey: `pipeline-child-${kind}`,
    provider,
    options,
  }
}

function bindReadySpeech(value: ProductionFixture, lineId: string): void {
  const asset = value.database.createMediaAsset({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    kind: 'dialogue.speech',
    status: 'ready',
    filePath: '/durable/ready-speech.mp3',
    mimeType: 'audio/mpeg',
    durationSeconds: 1,
    source: 'fixture',
    sourceRevisionId: value.sourceRevisionId,
  })
  value.database.withSql((sql) => sql.run(
    'UPDATE dialogue_lines SET speech_asset_id = ? WHERE id = ?',
    asset.id,
    lineId,
  ))
}

function bindReadyStoryboard(value: ProductionFixture, shotId: string): void {
  const asset = value.database.createMediaAsset({
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    kind: 'storyboard.image',
    status: 'ready',
    filePath: '/durable/ready-storyboard.png',
    mimeType: 'image/png',
    width: 1536,
    height: 1024,
    source: 'fixture',
    sourceRevisionId: value.sourceRevisionId,
  })
  value.database.withSql((sql) => sql.run(
    'UPDATE shots SET storyboard_asset_id = ? WHERE id = ?',
    asset.id,
    shotId,
  ))
}

function bindCharacterVoice(
  value: ProductionFixture,
  characterId: 'hero' | 'guardian',
  voiceId: string,
  delivery: { emotion: 'calm' | 'angry'; speed: number; pitch: number },
): { revisionId: string; databaseId: string } {
  const row = value.database.withSql((sql) => sql.get(`
    SELECT id, name, metadata_json FROM characters
     WHERE episode_id = ? AND json_extract(metadata_json, '$.storyId') = ?
  `, EPISODE_ID, characterId))
  assert.equal(typeof row?.id, 'string')
  assert.equal(typeof row?.metadata_json, 'string')
  const databaseId = String(row?.id)
  const profile: StoryCharacterVoiceProfile = {
    version: 1,
    voiceId,
    providerId: value.speechProvider.providerId,
    providerConfigRevision: value.speechProvider.configRevision,
    voiceType: 'system',
    voiceName: `${characterId} voice`,
    descriptions: [],
    selectionSource: 'manual',
    defaultDelivery: { emotion: 'calm', speed: 1, pitch: 0 },
    sceneDirections: [{
      sceneId: 'scene-1',
      ...delivery,
      rationale: `${characterId} scene direction`,
    }],
    catalogFingerprint: 'a'.repeat(64),
    catalogObservedAt: NOW,
    historicalPin: false,
    updatedAt: NOW,
  }
  const revision = value.database.createRevision({
    projectId: PROJECT_ID,
    summary: `voice ${characterId}`,
    snapshot: {
      version: 1,
      kind: 'character.voice-profile',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      characterId,
      characterName: String(row?.name),
      profile: profile as unknown as JsonObject,
    },
  })
  const metadata = JSON.parse(String(row?.metadata_json)) as Record<string, unknown>
  metadata.voiceProfile = profile
  metadata.voiceProfileRevisionId = revision.id
  value.database.withSql((sql) => sql.run(
    'UPDATE characters SET metadata_json = ? WHERE id = ?',
    JSON.stringify(metadata),
    databaseId,
  ))
  return { revisionId: revision.id, databaseId }
}

test('single-discovery preparation rejects fake audio and freezes reusable target discovery', (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const ids = databaseIds(value)
  const input = {
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    idempotencyKey: 'prepare-production',
    options: { speechMode: 'skip' as const },
    imageProvider: { providerId: value.imageProvider.providerId },
  }

  assert.throws(
    () => preparePipelineProduction({ database: value.database, timelines: { get: () => { throw Object.assign(new Error(), { code: 'TIMELINE_DOCUMENT_NOT_FOUND' }) } } }, input),
    (error: unknown) => error instanceof PipelineProductionError && error.code === 'AUDIO_REQUIRED',
  )

  bindReadySpeech(value, ids.lineId)
  const dependencies = {
    database: value.database,
    timelines: { get: () => { throw Object.assign(new Error(), { code: 'TIMELINE_DOCUMENT_NOT_FOUND' }) } },
  }
  const discovery = discoverPipelineProduction(dependencies, input)
  assert.equal(discovery.hasPublishableAudio, true)
  assert.equal(discovery.readySpeechCount, 1)
  assert.equal(discovery.storyboardTargets.length, 6)

  // Readiness changes after discovery, but request construction keeps the
  // authoritative preflight snapshot instead of silently scanning again.
  bindReadyStoryboard(value, ids.shotId)
  const frozen = createPipelineProductionRequestFromDiscovery(dependencies, input, discovery)
  assert.equal(frozen.targets.storyboard.length, 6)
  const prepared = preparePipelineProduction(dependencies, { ...input, idempotencyKey: 'prepare-later' })
  assert.equal(prepared.discovery.storyboardTargets.length, 5)
  assert.equal(prepared.request.targets.storyboard.length, 5)
  assert.equal(frozen.callerIntentFingerprint, prepared.request.callerIntentFingerprint)
})

test('per-target production inherits two character voices and scene delivery without a global voice', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  bindCharacterVoice(value, 'hero', 'voice-hero', { emotion: 'calm', speed: 0.9, pitch: 1 })
  bindCharacterVoice(value, 'guardian', 'voice-guardian', { emotion: 'angry', speed: 1.15, pitch: -2 })
  const dependencies = {
    database: value.database,
    timelines: { get: () => { throw Object.assign(new Error(), { code: 'TIMELINE_DOCUMENT_NOT_FOUND' }) } },
  }
  const discovery = discoverPipelineProduction(dependencies, {
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
  })
  assert.equal(discovery.voiceBlockers.length, 0)
  assert.equal(discovery.voiceSummary.boundCharacterCount, 2)
  assert.equal(discovery.voiceSummary.distinctVoiceCount, 2)
  assert.equal(discovery.voiceSummary.sceneDirectedTargetCount, 2)
  assert.deepEqual(
    discovery.speechBindings.map((binding) => [
      binding.characterId,
      binding.voiceId,
      binding.speed,
      binding.pitch,
      binding.emotion,
    ]),
    [
      ['hero', 'voice-hero', 0.9, 1, 'calm'],
      ['guardian', 'voice-guardian', 1.15, -2, 'angry'],
    ],
  )
  const request = createPipelineProductionRequestFromDiscovery(dependencies, {
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    idempotencyKey: 'per-character-voices',
    options: { speechMode: 'auto' },
    imageProvider: { providerId: value.imageProvider.providerId },
  }, discovery)
  assert.equal(request.options?.defaultVoiceId, undefined)
  assert.equal(request.speechProvider, undefined)
  assert.equal(request.speechBindings?.length, 2)

  for (const [index, binding] of discovery.speechBindings.entries()) {
    const result = await value.ports.submitSpeech({
      ...fanout(value, binding.targetId, binding.provider, 'speech'),
      targetIndex: index,
      idempotencyKey: `per-character-speech-${index}`,
      speechBinding: binding,
    })
    const job = value.database.getGenerationJob(result.jobId)!
    assert.equal(job.input.voiceId, binding.voiceId)
    assert.equal(job.input.inheritedVoiceProfileRevisionId, binding.voiceProfileRevisionId)
    assert.equal(job.input.speed, binding.speed)
    assert.equal(job.input.pitch, binding.pitch)
    assert.equal(job.input.emotion ?? null, binding.emotion)
    assert.equal(job.providerId, binding.provider.providerId)
    assert.equal(job.providerConfigRevision, binding.provider.configRevision)
  }
})

test('missing, changed, or removed character voices block before any speech child exists', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const dependencies = {
    database: value.database,
    timelines: { get: () => { throw Object.assign(new Error(), { code: 'TIMELINE_DOCUMENT_NOT_FOUND' }) } },
  }
  let discovery = discoverPipelineProduction(dependencies, {
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
  })
  assert.equal(discovery.voiceBlockers.length, 2)
  assert.throws(
    () => createPipelineProductionRequestFromDiscovery(dependencies, {
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      idempotencyKey: 'blocked-voices',
      options: { speechMode: 'auto' },
      imageProvider: { providerId: value.imageProvider.providerId },
    }, discovery),
    (error: unknown) => Boolean(error && typeof error === 'object'
      && 'code' in error
      && String((error as { code?: unknown }).code).startsWith('CHARACTER_VOICE_')),
  )
  assert.equal(value.database.listGenerationJobs({ limit: 100 }).length, 0)

  bindCharacterVoice(value, 'hero', 'voice-hero', { emotion: 'calm', speed: 1, pitch: 0 })
  bindCharacterVoice(value, 'guardian', 'voice-guardian', { emotion: 'angry', speed: 1, pitch: 0 })
  discovery = discoverPipelineProduction(dependencies, { projectId: PROJECT_ID, episodeId: EPISODE_ID })
  const catalogChanged = validatePipelineVoiceCatalog(discovery, {
    providerId: value.speechProvider.providerId,
    providerConfigRevision: value.speechProvider.configRevision,
    fingerprint: 'b'.repeat(64),
    voices: [{ voiceId: 'voice-hero' }],
  })
  assert.ok(catalogChanged.voiceBlockers.some((blocker) => blocker.code === 'CHARACTER_VOICE_CATALOG_CHANGED'))
  assert.equal(value.database.listGenerationJobs({ limit: 100 }).length, 0)

  const frozen = discovery.speechBindings[0]
  bindCharacterVoice(value, 'hero', 'voice-hero', { emotion: 'calm', speed: 1, pitch: -0.05 })
  const fractional = discoverPipelineProduction(dependencies, { projectId: PROJECT_ID, episodeId: EPISODE_ID })
  assert.ok(fractional.voiceBlockers.some((blocker) => (
    blocker.code === 'CHARACTER_VOICE_PROFILE_INVALID' && blocker.characterId === 'hero'
  )))
  assert.equal(value.database.listGenerationJobs({ limit: 100 }).length, 0)

  value.database.updateProviderConnection(value.speechProvider.providerId, {
    defaultModel: 'speech-rotated',
  })
  const rotated = discoverPipelineProduction(dependencies, { projectId: PROJECT_ID, episodeId: EPISODE_ID })
  assert.ok(rotated.voiceBlockers.some((blocker) => blocker.code === 'CHARACTER_VOICE_PROVIDER_CHANGED'))
  await assert.rejects(
    () => Promise.resolve(value.ports.submitSpeech({
      ...fanout(value, frozen.targetId, frozen.provider, 'speech'),
      idempotencyKey: 'stale-frozen-voice',
      speechBinding: frozen,
    })),
    (error: unknown) => Boolean(error && typeof error === 'object'
      && 'code' in error
      && String((error as { code?: unknown }).code).startsWith('CHARACTER_VOICE_')),
  )
  assert.equal(value.database.listGenerationJobs({ limit: 100 }).length, 0)
})

test('production fanout creates durable exact jobs without auto-enqueue', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const ids = databaseIds(value)

  const storyboard = await value.ports.submitStoryboard(fanout(
    value,
    ids.shotId,
    value.imageProvider,
    'storyboard',
  ))
  const storyboardJob = value.database.getGenerationJob(storyboard.jobId)!
  assert.equal(storyboardJob.status, 'queued')
  assert.equal(storyboardJob.type, 'asset.image.generate')
  assert.equal(storyboardJob.pipelineRunId, PIPELINE_RUN_ID)
  assert.equal(storyboardJob.providerId, value.imageProvider.providerId)
  assert.equal(storyboardJob.providerConfigRevision, value.imageProvider.configRevision)
  assert.equal(storyboardJob.input.storyboardBinding && (storyboardJob.input.storyboardBinding as JsonObject).databaseShotId, ids.shotId)
  assert.equal(storyboardJob.input.episodeBinding && (storyboardJob.input.episodeBinding as JsonObject).expectedRevisionId, value.sourceRevisionId)
  assert.match(String(storyboardJob.input.prompt), /阿离/)
  assert.equal(storyboardJob.input.size, '1536x1024')

  const speech = await value.ports.submitSpeech(fanout(
    value,
    ids.lineId,
    value.speechProvider,
    'speech',
  ))
  const speechJob = value.database.getGenerationJob(speech.jobId)!
  assert.equal(speechJob.status, 'queued')
  assert.equal(speechJob.type, 'dialogue.speech.generate')
  assert.equal(speechJob.input.databaseLineId, ids.lineId)
  assert.equal(speechJob.input.expectedRevisionId, value.sourceRevisionId)
  assert.equal(speechJob.input.voiceId, 'voice-1')
  assert.equal(speechJob.input.format, 'mp3')
  assert.equal(value.calls.admissions.length, 2)
  assert.deepEqual(value.calls.enqueue, [])
})

test('timeline production bridge materializes once then reconciles the exact head', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const request = {
    pipelineRunId: PIPELINE_RUN_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: value.sourceRevisionId,
  }

  const created = await value.ports.materializeOrReconcile(request)
  assert.equal(created.revisionId, 'timeline-created')
  assert.equal(value.calls.materialize.length, 1)
  assert.equal(value.calls.materialize[0].expectedRevisionId, null)
  assert.equal(value.calls.materialize[0].autoLayoutManagedDialogue, false)
  assert.equal(value.calls.autoEditPreview.length, 1)
  assert.equal(value.calls.autoEditApply.length, 0)

  value.timeline.current = {
    timelineDocument: {
      id: 'timeline-document',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      currentRevisionId: 'timeline-head',
      schemaVersion: 2,
      upstreamCommit: '0'.repeat(40),
      sourceRevisionId: value.sourceRevisionId,
      createdAt: NOW,
      updatedAt: NOW,
    },
    revision: {
      id: 'timeline-head',
      documentId: 'timeline-document',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      parentRevisionId: null,
      schemaVersion: 2,
      upstreamCommit: '0'.repeat(40),
      sourceRevisionId: value.sourceRevisionId,
      summary: 'head',
      snapshot: {},
      createdAt: NOW,
    },
    document: {},
    etag: '"timeline-head"',
  }
  const reconciled = await value.ports.materializeOrReconcile(request)
  assert.equal(reconciled.revisionId, 'timeline-reconciled')
  assert.equal(value.calls.reconcile.length, 1)
  assert.equal(value.calls.reconcile[0].expectedRevisionId, 'timeline-head')
  assert.equal(value.calls.reconcile[0].autoLayoutManagedDialogue, false)
  assert.equal(value.calls.autoEditPreview.length, 2)
  assert.equal(value.calls.autoEditApply.length, 0)
})

test('timeline production persists the same plan/application audit contract as manual auto-edit', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  value.autoEdit.enabled = true

  const result = await value.ports.materializeOrReconcile({
    pipelineRunId: PIPELINE_RUN_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: value.sourceRevisionId,
  })

  assert.equal(result.revisionId, 'timeline-auto-edited')
  assert.deepEqual(result.automaticEdit, {
    strategy: 'managed-dialogue-reflow-v1',
    executor: 'OpenCut-Classic/UpdateElementsCommand',
    planHash: 'a'.repeat(64),
    operationCount: 1,
    changedElementIds: ['dialogue-1'],
    planId: 'auto-edit-plan',
    applicationId: 'auto-edit-application',
  })
  assert.equal(value.calls.autoEditPreview.length, 1)
  assert.equal(value.calls.autoEditApply.length, 1)
  assert.equal(
    value.calls.autoEditApply[0].idempotencyKey,
    `pipeline:${PIPELINE_RUN_ID}:timeline-auto-edit:v1`,
  )
  assert.equal(value.calls.autoEditApply[0].planId, 'auto-edit-plan')
})

test('timeline production fails closed before applying a blocked automatic edit', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  value.autoEdit.blocked = true

  await assert.rejects(
    Promise.resolve().then(() => value.ports.materializeOrReconcile({
      pipelineRunId: PIPELINE_RUN_ID,
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      sourceRevisionId: value.sourceRevisionId,
    })),
    (error: unknown) => error instanceof PipelineProductionError
      && error.code === 'INVALID_TIMELINE'
      && error.message.includes('非托管音频越界'),
  )
  assert.equal(value.calls.autoEditPreview.length, 1)
  assert.equal(value.calls.autoEditApply.length, 0)
})

test('timeline production atomically persists real plan/application rows and rolls back a blocked candidate', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const timelines = new TimelineDocumentService(
    new SQLiteTimelineDocumentRepository(value.database),
  )
  const materialize = (input: {
    projectId: string
    episodeId: string
    expectedRevisionId: null
    summary?: string
  }) => ({
    ...timelines.saveReconciled({
      projectId: input.projectId,
      episodeId: input.episodeId,
      expectedRevisionId: null,
      schemaVersion: 2,
      upstreamCommit: PINNED_OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: value.sourceRevisionId,
      summary: input.summary ?? 'pipeline base',
      document: {
        version: 2,
        editor: 'OpenCut-Classic',
        upstreamCommit: PINNED_OPEN_CUT_CLASSIC_COMMIT,
        ticksPerSecond: 120_000,
        frameRate: { numerator: 24, denominator: 1 },
        tracks: {
          overlay: [{
            id: 'visual-main',
            name: 'Visual',
            type: 'video',
            hidden: false,
            muted: false,
            elements: [{
              id: 'visual-1',
              name: 'Visual 1',
              type: 'image',
              mediaId: 'fixture-storyboard',
              startTime: 0,
              duration: 120_000,
              trimStart: 0,
              trimEnd: 0,
              params: { storyShotId: 'shot-1' },
            }],
          }],
          main: {
            id: 'main',
            name: 'Main',
            type: 'video',
            hidden: false,
            muted: false,
            elements: [],
          },
          audio: [],
        },
      },
    }),
    created: true,
    report: {},
  }) as never
  let blocked = false
  const planner: TimelineAutoEditPlanner = {
    preview(input) {
      const operation = {
        kind: 'update-element-timing' as const,
        trackId: 'visual-main',
        elementId: 'visual-1',
        reason: 'extend-managed-visual-tail' as const,
        before: { startTime: 0, duration: 120_000, trimStart: 0, trimEnd: 0 },
        after: { startTime: 0, duration: 240_000, trimStart: 0, trimEnd: 0 },
      }
      const document = structuredClone(input.base.document)
      const tracks = document.tracks as unknown as {
        overlay: Array<{ elements: Array<{ id: string; duration: number }> }>
      }
      const visual = tracks.overlay.flatMap((track) => track.elements)
        .find((element) => element.id === 'visual-1')
      assert.ok(visual)
      visual.duration = 240_000
      document.manjuTimeline = {
        automaticEdit: {
          version: 1,
          strategy: 'managed-dialogue-reflow-v1',
          executor: 'OpenCut-Classic/UpdateElementsCommand',
          planHash: blocked ? 'b'.repeat(64) : 'a'.repeat(64),
          baseRevisionId: input.base.revision.id,
          sourceRevisionId: value.sourceRevisionId,
          risk: blocked ? 'blocked' : 'safe',
          policy: 'auto-applied',
          operationCount: 1,
          changedElementIds: ['visual-1'],
        },
      }
      return {
        sourceRevisionId: value.sourceRevisionId,
        schemaVersion: 2,
        upstreamCommit: PINNED_OPEN_CUT_CLASSIC_COMMIT,
        strategy: 'managed-dialogue-reflow-v1',
        executor: 'OpenCut-Classic/UpdateElementsCommand',
        planHash: blocked ? 'b'.repeat(64) : 'a'.repeat(64),
        risk: blocked ? 'blocked' : 'safe',
        diagnostics: blocked ? [{
          code: 'UNSAFE_AUDIO_OUT_OF_BOUNDS',
          severity: 'error',
          message: '非托管音频仍然越界',
          elementIds: [],
        }] : [],
        operations: [operation],
        changedElementIds: ['visual-1'],
        document,
      }
    },
  }
  const ids = ['real-plan', 'real-application', 'blocked-plan']
  const edits = new TimelineAutoEditService(
    value.database,
    timelines,
    new SQLiteTimelineAutoEditRepository(value.database),
    planner,
    {
      idFactory: () => ids.shift() ?? randomUUID(),
      tokenFactory: () => `taec_${'pipeline'.repeat(8)}`,
      now: () => NOW,
    },
  )
  const ports = createPipelineProductionPorts({
    database: value.database,
    stories: value.stories,
    timelines,
    timelineMaterialization: {
      materialize,
      reconcile() {
        throw new Error('unexpected reconcile')
      },
    },
    timelineAutoEdit: edits,
    exports: { create() { throw new Error('unused') } },
    qualityChecks: {
      create() { throw new Error('unused') },
      requireDownloadAuthorization() { throw new Error('unused') },
    },
    durableJobs: { create() { throw new Error('unused') } },
    async admitDurableJob(_identity, operation) { return operation() },
    worker: { enqueue() {}, async cancel() { return undefined } },
  })
  const applied = await ports.materializeOrReconcile({
    pipelineRunId: PIPELINE_RUN_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: value.sourceRevisionId,
  })
  assert.equal(applied.automaticEdit?.planId, 'real-plan')
  assert.equal(applied.automaticEdit?.applicationId, 'real-application')
  assert.equal(timelines.get(EPISODE_ID).revision.id, applied.revisionId)
  const audit = value.database.withSql((sql) => sql.get(`
    SELECT
      (SELECT COUNT(*) FROM timeline_auto_edit_plans) AS plan_count,
      (SELECT COUNT(*) FROM timeline_edit_applications) AS application_count
  `))
  assert.equal(audit?.plan_count, 1)
  assert.equal(audit?.application_count, 1)

  const blockedEpisode = value.stories.ensureEpisode(PROJECT_ID, {
    id: 'blocked-episode',
    title: 'Blocked',
  })
  value.database.withSql((sql) => sql.run(
    'UPDATE episodes SET source_revision_id = ? WHERE id = ?',
    value.sourceRevisionId,
    blockedEpisode.id,
  ))
  blocked = true
  await assert.rejects(
    Promise.resolve().then(() => ports.materializeOrReconcile({
      pipelineRunId: 'blocked-pipeline-run',
      projectId: PROJECT_ID,
      episodeId: blockedEpisode.id,
      sourceRevisionId: value.sourceRevisionId,
    })),
    (error: unknown) => error instanceof PipelineProductionError
      && error.code === 'INVALID_TIMELINE',
  )
  assert.throws(
    () => timelines.get(blockedEpisode.id),
    (error: unknown) => error instanceof TimelineDocumentError
      && error.code === 'TIMELINE_DOCUMENT_NOT_FOUND',
  )
  const afterBlocked = value.database.withSql((sql) => sql.get(`
    SELECT
      (SELECT COUNT(*) FROM timeline_auto_edit_plans) AS plan_count,
      (SELECT COUNT(*) FROM timeline_edit_applications) AS application_count
  `))
  assert.equal(afterBlocked?.plan_count, 1)
  assert.equal(afterBlocked?.application_count, 1)
})

test('export and QC preserve parent identity and authoritative QC rejects a report mismatch', async (t) => {
  const value = fixture()
  t.after(() => value.database.close())
  const exported = await value.ports.createExport({
    pipelineRunId: PIPELINE_RUN_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: value.sourceRevisionId,
    timelineRevisionId: 'timeline-created',
    idempotencyKey: 'pipeline-export',
    options,
  })
  assert.equal(value.calls.exports[0].pipelineRunId, PIPELINE_RUN_ID)
  assert.equal(value.calls.exports[0].timelineRevisionId, 'timeline-created')

  const quality = await value.ports.createQuality({
    pipelineRunId: PIPELINE_RUN_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: value.sourceRevisionId,
    exportId: exported.exportId,
    idempotencyKey: 'pipeline-quality',
  })
  assert.equal(value.calls.quality[0].pipelineRunId, PIPELINE_RUN_ID)
  assert.equal(value.calls.quality[0].exportId, exported.exportId)
  const currentAuthorization = {
    export: {
      id: exported.exportId,
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      timelineRevisionId: 'timeline-created',
      timelineSnapshot: { storyRevisionId: value.sourceRevisionId },
    },
    report: {
      id: quality.reportId,
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      exportId: exported.exportId,
      document: {
        policy: DEFAULT_QUALITY_POLICY,
        checks: REQUIRED_RELEASE_QUALITY_CHECK_IDS.map((id) => ({
          id,
          status: 'passed',
          severity: 'info',
          message: 'ok',
          metrics: {},
        })),
        binding: {
          timelineRevisionId: 'timeline-created',
          storyRevisionId: value.sourceRevisionId,
        },
      },
    },
    asset: {},
  } as unknown as QualityDownloadAuthorization
  value.setAuthorization(currentAuthorization)

  const authorizationRequest = {
    pipelineRunId: PIPELINE_RUN_ID,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    sourceRevisionId: value.sourceRevisionId,
    exportId: exported.exportId,
    reportId: quality.reportId,
  }
  const legacyAuthorization = structuredClone(currentAuthorization)
  legacyAuthorization.report.document.checks = legacyAuthorization.report.document.checks.slice(0, 5)
  value.setAuthorization(legacyAuthorization)
  await assert.rejects(
    async () => value.ports.authorizeQuality(authorizationRequest),
    (error: unknown) => error instanceof PipelineProductionError
      && error.code === 'QUALITY_BINDING_CONFLICT',
  )

  value.setAuthorization(currentAuthorization)
  assert.deepEqual(await value.ports.authorizeQuality(authorizationRequest), { passed: true })
  assert.deepEqual(value.calls.authorize, [exported.exportId, exported.exportId])
  await assert.rejects(
    async () => value.ports.authorizeQuality({ ...authorizationRequest, reportId: randomUUID() }),
    (error: unknown) => error instanceof PipelineProductionError
      && error.code === 'QUALITY_BINDING_CONFLICT',
  )
  assert.deepEqual(value.calls.authorize, [exported.exportId, exported.exportId, exported.exportId])
  assert.equal(value.calls.admissions.length, 2)
  assert.deepEqual(value.calls.enqueue, [])
})
