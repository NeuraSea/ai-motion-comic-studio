import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { ExportRenderError, ExportRenderService } from './export-render.js'
import { StoryRepository } from './story-repository.js'
import {
  createTimelineMaterializationAutoEditPlanner,
  SQLiteTimelineAutoEditRepository,
  TimelineAutoEditService,
} from './timeline-auto-edit.js'
import type { StoryDocument, StoryShot } from './story-schema.js'
import {
  OPEN_CUT_CLASSIC_COMMIT,
  OPEN_CUT_TICKS_PER_SECOND,
  TimelineMaterializationError,
  TimelineMaterializationService,
} from './timeline-materialization.js'
import {
  mediaAuthorityFingerprint,
  timelineMediaAuthorityReceipt,
} from './media-authority.js'
import { versionTokenFromEtag } from './episode-version.js'
import { ShotMediaReviewService } from './shot-media-review.js'
import {
  SQLiteTimelineDocumentRepository,
  TimelineDocumentError,
  TimelineDocumentService,
} from './timeline-documents.js'
import type { JsonObject } from './types.js'

interface Fixture {
  database: ManjuDatabase
  stories: StoryRepository
  timelines: TimelineDocumentService
  materialization: TimelineMaterializationService
  story: StoryDocument
  sourceRevisionId: string
}

function generatedStory(shotCount = 7): StoryDocument {
  const shots: StoryShot[] = Array.from({ length: shotCount }, (_, index) => ({
    id: `shot-${index + 1}`,
    sequence: index,
    code: `S${index + 1}`,
    title: `镜头 ${index + 1}`,
    description: `第 ${index + 1} 个镜头`,
    framing: '中景',
    movement: '固定',
    transition: '硬切',
    durationSeconds: index === shotCount - 1 ? 3 : 5,
    visualPrompt: `visual ${index + 1}`,
    dialogueLines: index === 0 ? [{
      id: 'line-1',
      sequence: 0,
      kind: 'dialogue',
      speaker: '阿离',
      text: '开始。',
    }] : [],
  }))
  return {
    version: 1,
    title: '时间线剧本',
    targetDurationSeconds: shotCount * 5 - 2,
    bible: {
      logline: '一段可编辑的短篇漫剧。',
      theme: '选择',
      tone: '克制',
      visualStyle: '国风动画',
    },
    characters: [{
      id: 'character-1',
      name: '阿离',
      role: '主角',
      storyDescription: '寻找真相。',
      visualDescription: '黑发红衣。',
    }],
    locations: [{
      id: 'location-1',
      name: '古殿',
      storyDescription: '废弃古殿。',
      visualDescription: '月光照入石殿。',
    }],
    props: [],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '古殿',
      locationId: 'location-1',
      timeOfDay: '夜',
      description: '主角进入古殿。',
      shots,
    }],
  }
}

function fixture(story: StoryDocument = generatedStory()): Fixture {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  database.createProject({ id: 'project-1', title: '时间线项目' })
  database.createProject({ id: 'project-2', title: '另一个项目' })
  const stories = new StoryRepository(database)
  stories.ensureEpisode('project-1', { id: 'episode-1', title: '时间线剧本' })
  const revision = database.createRevision({
    id: 'story-revision-1',
    projectId: 'project-1',
    summary: '初始剧本',
    snapshot: structuredClone(story) as unknown as JsonObject,
  })
  stories.applyStory('episode-1', story, revision.id)
  const timelines = new TimelineDocumentService(new SQLiteTimelineDocumentRepository(database))
  return {
    database,
    stories,
    timelines,
    materialization: new TimelineMaterializationService(database, stories, timelines),
    story,
    sourceRevisionId: revision.id,
  }
}

function timelineTracks(document: JsonObject) {
  return document.tracks as unknown as {
    overlay: Array<{
      id: string
      name: string
      type: string
      hidden: boolean
      muted?: boolean
      elements: Array<Record<string, unknown> & {
        id: string
        startTime: number
        duration: number
        mediaId?: string
        sourceType?: 'upload' | 'library'
        manju?: Record<string, unknown>
        params: Record<string, unknown>
      }>
    }>
    main: { id: string; type: string; elements: Array<Record<string, unknown>> }
    audio: Array<Record<string, unknown>>
  }
}

function isTimelineError(code: string) {
  return (error: unknown) => error instanceof TimelineDocumentError && error.code === code
}

function bindSpeechAsset(
  context: Fixture,
  lineId: string,
  assetId: string,
  options: {
    durationSeconds?: number | null
    lineDurationSeconds?: number | null
    mimeType?: string | null
    generationParameters?: JsonObject
  } = {},
): void {
  const durationSeconds = options.durationSeconds === undefined ? 1 : options.durationSeconds
  context.database.createMediaAsset({
    id: assetId,
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'speech',
    source: 'fixture',
    filePath: `/fixture/${assetId}.mp3`,
    checksum: 'b'.repeat(64),
    sourceRevisionId: context.stories.getEpisode('episode-1')?.sourceRevisionId,
    mimeType: options.mimeType === undefined ? 'audio/mpeg' : options.mimeType,
    durationSeconds,
    generationParameters: options.generationParameters,
  })
  const changed = context.database.withSql((sql) => sql.run(`
    UPDATE dialogue_lines
    SET speech_asset_id = ?, duration_seconds = ?
    WHERE json_extract(metadata_json, '$.storyId') = ?
  `,
  assetId,
  options.lineDurationSeconds === undefined ? durationSeconds : options.lineDurationSeconds,
  lineId,
  )).changes
  assert.equal(changed, 1)
}

function createStoryboardCandidate(
  context: Fixture,
  assetId: string,
  checksumCharacter: 'a' | 'b' | 'c',
  createdAt: string,
): void {
  const shot = context.database.withSql((sql) => sql.get(`
    SELECT shots.id AS database_shot_id
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
     WHERE scenes.episode_id = 'episode-1'
       AND json_extract(scenes.metadata_json, '$.storyId') = 'scene-1'
       AND json_extract(shots.metadata_json, '$.storyId') = 'shot-1'
  `))
  assert.equal(typeof shot?.database_shot_id, 'string')
  const databaseShotId = shot!.database_shot_id as string
  const jobId = `job-${assetId}`
  context.database.createGenerationJob({
    id: jobId,
    projectId: 'project-1',
    episodeId: 'episode-1',
    type: 'asset.image.generate',
    status: 'succeeded',
    progress: 100,
    resourceId: databaseShotId,
    input: {
      count: 1,
      metadata: { kind: 'storyboard' },
      storyboardBinding: {
        episodeId: 'episode-1',
        shotId: 'shot-1',
        sceneId: 'scene-1',
        databaseShotId,
        expectedRevisionId: context.sourceRevisionId,
      },
    },
    completedAt: createdAt,
  })
  context.database.createMediaAsset({
    id: assetId,
    projectId: 'project-1',
    episodeId: 'episode-1',
    kind: 'storyboard',
    status: 'ready',
    source: 'provider',
    filePath: `/fixture/${assetId}.png`,
    mimeType: 'image/png',
    checksum: checksumCharacter.repeat(64),
    generationJobId: jobId,
    generationParameters: {
      shotId: 'shot-1',
      sceneId: 'scene-1',
      sourceRevisionId: context.sourceRevisionId,
    },
    sourceRevisionId: context.sourceRevisionId,
    createdAt,
    updatedAt: createdAt,
  })
}

function selectStoryboard(context: Fixture, assetId: string): void {
  const changed = context.database.withSql((sql) => sql.run(`
    UPDATE shots SET storyboard_asset_id = ?
     WHERE scene_id IN (
       SELECT id FROM scenes
        WHERE episode_id = 'episode-1'
          AND json_extract(metadata_json, '$.storyId') = 'scene-1'
     )
       AND json_extract(metadata_json, '$.storyId') = 'shot-1'
  `, assetId)).changes
  assert.equal(changed, 1)
}

test('materialize creates a frame-aligned OpenCut document atomically from the current story', () => {
  const context = fixture()
  try {
    assert.throws(() => context.materialization.materialize({
      projectId: 'project-2',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    }), isTimelineError('EPISODE_PROJECT_MISMATCH'))
    assert.throws(
      () => context.timelines.get('episode-1'),
      isTimelineError('TIMELINE_DOCUMENT_NOT_FOUND'),
    )

    context.database.createMediaAsset({
      id: 'storyboard-asset-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'storyboard',
      source: 'fixture',
      sourceRevisionId: context.sourceRevisionId,
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'storyboard-asset-1'
      WHERE json_extract(metadata_json, '$.storyId') = 'shot-1'
    `))
    bindSpeechAsset(context, 'line-1', 'speech-asset-1', {
      durationSeconds: 1.23,
      lineDurationSeconds: 1.1,
    })

    const result = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const tracks = timelineTracks(result.document)
    const elements = tracks.overlay[0].elements

    assert.equal(result.created, true)
    assert.equal(result.timelineDocument.schemaVersion, 2)
    assert.equal(result.revision.schemaVersion, 2)
    assert.equal(result.document.version, 2)
    assert.equal(result.timelineDocument.sourceRevisionId, context.sourceRevisionId)
    assert.equal(result.revision.sourceRevisionId, context.sourceRevisionId)
    assert.equal(result.document.editor, 'OpenCut-Classic')
    assert.equal(result.document.upstreamCommit, OPEN_CUT_CLASSIC_COMMIT)
    assert.equal(result.document.ticksPerSecond, OPEN_CUT_TICKS_PER_SECOND)
    assert.deepEqual(result.document.frameRate, { numerator: 24, denominator: 1 })
    assert.equal(elements.length, 7)
    assert.deepEqual(elements.map((element) => element.startTime), [
      0,
      150_000,
      750_000,
      1_350_000,
      1_950_000,
      2_550_000,
      3_150_000,
    ])
    assert.deepEqual(elements.map((element) => element.duration), [
      150_000,
      600_000,
      600_000,
      600_000,
      600_000,
      600_000,
      360_000,
    ])
    assert.deepEqual(elements.map((element) => element.params.storyShotId), [
      'shot-1',
      'shot-2',
      'shot-3',
      'shot-4',
      'shot-5',
      'shot-6',
      'shot-7',
    ])
    assert.equal(elements[0].type, 'image')
    assert.equal(elements[0].mediaId, 'storyboard-asset-1')
    assert.equal(elements[0].params.assetId, undefined)
    assert.equal(elements[0].params.storyAssetId, 'storyboard-asset-1')
    assert.ok(elements.every((element) => (
      element.params.sourceRevisionId === context.sourceRevisionId
    )))
    assert.equal(tracks.audio.length, 1)
    const dialogueAudio = (tracks.audio[0] as unknown as {
      id: string
      elements: Array<{
        id: string
        type: string
        mediaId: string
        sourceType: string
        startTime: number
        duration: number
        params: Record<string, unknown>
      }>
    })
    assert.equal(dialogueAudio.id, 'dialogue-main')
    assert.equal(dialogueAudio.elements.length, 1)
    assert.equal(dialogueAudio.elements[0].type, 'audio')
    assert.equal(dialogueAudio.elements[0].sourceType, 'upload')
    assert.equal(dialogueAudio.elements[0].mediaId, 'speech-asset-1')
    assert.equal(dialogueAudio.elements[0].startTime, 0)
    assert.equal(dialogueAudio.elements[0].duration, 150_000)
    assert.deepEqual(dialogueAudio.elements[0].params, {
      dialogueLineId: 'line-1',
      storyShotId: 'shot-1',
      storySceneId: 'scene-1',
      storyManagedAssetId: 'speech-asset-1',
      sourceRevisionId: context.sourceRevisionId,
    })
    assert.equal(result.report.operation, 'materialize')
    assert.equal(result.report.appendedShots.length, 7)
    assert.equal(result.report.appendedDialogueAudio.length, 1)
    assert.deepEqual(result.report.speechConflicts.map((conflict) => conflict.code), [
      'SPEECH_DURATION_MISMATCH',
    ])

    assert.throws(() => context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    }), isTimelineError('TIMELINE_DOCUMENT_CONFLICT'))
    assert.throws(() => context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: result.revision.id,
    }), isTimelineError('TIMELINE_DOCUMENT_CONFLICT'))
    const noOpCandidate = context.materialization.planAutomaticEdit({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: result.revision.id,
    })
    assert.equal(noOpCandidate.status, 'noop')
    assert.equal(noOpCandidate.receipt, null)
    assert.deepEqual(noOpCandidate.document, result.document)
    assert.throws(() => context.materialization.planAutomaticEdit({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: 'stale-timeline-revision',
    }), isTimelineError('TIMELINE_DOCUMENT_CONFLICT'))
    assert.equal(context.timelines.listRevisions(result.timelineDocument.id).revisions.length, 1)
  } finally {
    context.database.close()
  }
})

test('materialize atomically projects provider word timestamps from the exact speech Asset', () => {
  const story = generatedStory(7)
  story.scenes[0]!.shots[0]!.dialogueLines = []
  story.scenes[0]!.shots[1]!.dialogueLines = [{
    id: 'line-word',
    sequence: 0,
    kind: 'narration',
    speaker: '',
    text: '风从殿外吹来。',
  }]
  const context = fixture(story)
  try {
    bindSpeechAsset(context, 'line-word', 'speech-word', {
      durationSeconds: 2,
      generationParameters: {
        lineId: 'line-word',
        subtitle: {
          mode: 'word',
          granularity: 'word',
          cues: [
            { text: '风从', startMs: 0, endMs: 700 },
            { text: '殿外吹来', startMs: 700, endMs: 1_800 },
          ],
        },
      },
    })
    const result = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const tracks = timelineTracks(result.document)
    const audio = (tracks.audio[0] as unknown as {
      elements: Array<{ id: string; startTime: number; duration: number }>
    }).elements[0]!
    const subtitleTrack = tracks.overlay.find((track) => (
      track.id === 'manju-managed-speech-subtitles'
    ))!
    assert.ok(subtitleTrack)
    assert.equal(audio.startTime, 600_000)
    assert.deepEqual(subtitleTrack.elements.map((element) => ({
      text: element.params.text,
      startTime: element.startTime,
      duration: element.duration,
      source: (element.manju?.subtitleCue as Record<string, unknown> | undefined),
    })), [
      {
        text: '风从',
        startTime: 600_000,
        duration: 85_000,
        source: {
          version: 1,
          cueSetId: (subtitleTrack.elements[0]!.manju!.subtitleCue as Record<string, unknown>).cueSetId,
          dialogueLineId: 'line-word',
          storySceneId: 'scene-1',
          storyShotId: 'shot-2',
          speechAssetId: 'speech-word',
          sourceAudioElementId: audio.id,
          sourceCueIndex: 0,
          sourceStartMs: 0,
          sourceEndMs: 700,
          sourceAudioStartTime: 600_000,
          sourceAudioTrimStart: 0,
          sourceAudioDuration: 240_000,
        },
      },
      {
        text: '殿外吹来',
        startTime: 685_000,
        duration: 130_000,
        source: {
          version: 1,
          cueSetId: (subtitleTrack.elements[1]!.manju!.subtitleCue as Record<string, unknown>).cueSetId,
          dialogueLineId: 'line-word',
          storySceneId: 'scene-1',
          storyShotId: 'shot-2',
          speechAssetId: 'speech-word',
          sourceAudioElementId: audio.id,
          sourceCueIndex: 1,
          sourceStartMs: 700,
          sourceEndMs: 1_800,
          sourceAudioStartTime: 600_000,
          sourceAudioTrimStart: 0,
          sourceAudioDuration: 240_000,
        },
      },
    ])
    assert.equal(
      (subtitleTrack.elements[0]!.manju!.subtitleCue as Record<string, unknown>).cueSetId,
      (subtitleTrack.elements[1]!.manju!.subtitleCue as Record<string, unknown>).cueSetId,
    )
    assert.match(
      String((subtitleTrack.elements[0]!.manju!.subtitleCue as Record<string, unknown>).cueSetId),
      /^auto-speech-[0-9a-f]{40}$/,
    )
  } finally {
    context.database.close()
  }
})

test('materialize uses the immutable sentence over the complete real audio interval and is idempotent', () => {
  const context = fixture()
  try {
    bindSpeechAsset(context, 'line-1', 'speech-fallback', {
      durationSeconds: 1.23,
      generationParameters: {
        lineId: 'line-1',
        subtitle: { mode: 'sentence-fallback', reason: 'provider-returned-no-sidecar' },
      },
    })
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const subtitle = timelineTracks(materialized.document).overlay
      .find((track) => track.id === 'manju-managed-speech-subtitles')!.elements[0]!
    const provenance = subtitle.manju!.subtitleCue as Record<string, unknown>
    assert.equal(subtitle.params.text, '开始。')
    assert.equal(subtitle.startTime, 0)
    assert.equal(subtitle.duration, 150_000)
    assert.equal(provenance.sourceStartMs, 0)
    assert.equal(provenance.sourceEndMs, 1_230)
    assert.equal(provenance.sourceAudioDuration, 150_000)

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
    })
    assert.equal(reconciled.report.changed, false)
    assert.equal(reconciled.revision.id, materialized.revision.id)
    assert.deepEqual(reconciled.document, materialized.document)
  } finally {
    context.database.close()
  }
})

test('materialize fails closed on a stale-revision speech Asset without forging current provenance', () => {
  const context = fixture()
  try {
    context.database.createRevision({
      id: 'story-revision-old-speech',
      projectId: 'project-1',
      summary: '旧语音来源修订',
      snapshot: structuredClone(context.story) as unknown as JsonObject,
    })
    context.database.createMediaAsset({
      id: 'stale-revision-speech',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'speech',
      status: 'ready',
      source: 'fixture',
      filePath: '/fixture/stale-revision-speech.mp3',
      checksum: 'd'.repeat(64),
      sourceRevisionId: 'story-revision-old-speech',
      mimeType: 'audio/mpeg',
      durationSeconds: 1,
      generationParameters: {
        lineId: 'line-1',
        subtitle: { mode: 'sentence-fallback', reason: 'fixture' },
      },
    })
    const changed = context.database.withSql((sql) => sql.run(`
      UPDATE dialogue_lines
         SET speech_asset_id = 'stale-revision-speech', duration_seconds = 1
       WHERE json_extract(metadata_json, '$.storyId') = 'line-1'
    `)).changes
    assert.equal(changed, 1)

    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const tracks = timelineTracks(materialized.document)
    assert.deepEqual(tracks.audio, [])
    assert.equal(tracks.overlay.some((track) => (
      track.id === 'manju-managed-speech-subtitles'
    )), false)
    assert.deepEqual(materialized.report.speechConflicts, [{
      sceneId: 'scene-1',
      shotId: 'shot-1',
      dialogueLineId: 'line-1',
      code: 'SPEECH_ASSET_REVISION_MISMATCH',
      assetId: 'stale-revision-speech',
      blocking: true,
      message: '语音资产不属于当前 Story 修订',
    }])
    assert.equal(JSON.stringify(materialized.document).includes('stale-revision-speech'), false)
  } finally {
    context.database.close()
  }
})

test('reconcile orphans stale speech without relabeling its provenance and removes only automatic subtitles', () => {
  const context = fixture()
  try {
    bindSpeechAsset(context, 'line-1', 'speech-before-story-change', {
      durationSeconds: 1.23,
      generationParameters: {
        lineId: 'line-1',
        subtitle: { mode: 'sentence-fallback', reason: 'fixture' },
      },
    })
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const beforeTracks = timelineTracks(materialized.document)
    const beforeAudio = (beforeTracks.audio[0] as unknown as {
      elements: Array<{ params: Record<string, unknown> }>
    }).elements[0]!
    assert.equal(beforeAudio.params.sourceRevisionId, context.sourceRevisionId)
    assert.equal(beforeTracks.overlay.find((track) => (
      track.id === 'manju-managed-speech-subtitles'
    ))!.elements.length, 1)

    const nextRevision = context.database.createRevision({
      id: 'story-revision-after-speech',
      projectId: 'project-1',
      parentRevisionId: context.sourceRevisionId,
      summary: '模拟语音生成后的剧本修订',
      snapshot: structuredClone(context.story) as unknown as JsonObject,
    })
    const changed = context.database.withSql((sql) => sql.run(`
      UPDATE episodes SET source_revision_id = ? WHERE id = 'episode-1'
    `, nextRevision.id)).changes
    assert.equal(changed, 1)
    context.database.updateProject('project-1', { currentRevisionId: nextRevision.id })

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
    })
    const afterTracks = timelineTracks(reconciled.document)
    const afterAudio = (afterTracks.audio[0] as unknown as {
      elements: Array<{ mediaId: string; params: Record<string, unknown> }>
    }).elements[0]!
    assert.notEqual(afterAudio.mediaId, 'speech-before-story-change')
    assert.equal(afterAudio.params.storyManagedAssetId, undefined)
    assert.equal(afterAudio.params.dialogueOrphaned, true)
    assert.equal(afterAudio.params.dialogueOrphanReason, 'speech-asset-invalid')
    assert.equal(afterAudio.params.sourceRevisionId, context.sourceRevisionId)
    assert.equal(afterAudio.params.orphanedAtSourceRevisionId, nextRevision.id)
    assert.equal(afterTracks.overlay.flatMap((track) => track.elements).some((element) => {
      const raw = element.manju?.subtitleCue as Record<string, unknown> | undefined
      return typeof raw?.cueSetId === 'string' && raw.cueSetId.startsWith('auto-speech-')
    }), false)
    assert.deepEqual(reconciled.report.speechConflicts.map((conflict) => conflict.code), [
      'SPEECH_ASSET_REVISION_MISMATCH',
    ])

    const noOp = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: reconciled.revision.id,
    })
    assert.equal(noOp.report.changed, false)
    assert.equal(noOp.revision.id, reconciled.revision.id)
  } finally {
    context.database.close()
  }
})

test('reconcile never overlays an explicitly line-bound manual cue with generated subtitles', () => {
  const context = fixture()
  try {
    const initial = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const editedDocument = structuredClone(initial.document)
    timelineTracks(editedDocument).overlay.push({
      id: 'manual-line-subtitles',
      name: '手工字幕',
      type: 'text',
      hidden: false,
      muted: false,
      elements: [{
        id: 'manual-line-1-cue',
        type: 'text',
        name: '手工校订文案',
        startTime: 0,
        duration: 120_000,
        trimStart: 0,
        trimEnd: 0,
        params: {
          content: '手工校订文案',
          text: '手工校订文案',
          manjuRole: 'subtitle',
          dialogueLineId: 'line-1',
          storySceneId: 'scene-1',
          storyShotId: 'shot-1',
        },
      }],
    })
    const edited = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: initial.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: '用户手工字幕',
      document: editedDocument,
    })
    bindSpeechAsset(context, 'line-1', 'speech-after-manual', {
      durationSeconds: 1,
      generationParameters: { lineId: 'line-1' },
    })
    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: edited.revision.id,
    })
    const tracks = timelineTracks(reconciled.document)
    assert.equal(tracks.overlay.find((track) => (
      track.id === 'manju-managed-speech-subtitles'
    )), undefined)
    assert.equal(
      tracks.overlay.find((track) => track.id === 'manual-line-subtitles')!.elements[0]!.params.text,
      '手工校订文案',
    )
    assert.equal((tracks.audio[0] as unknown as { elements: unknown[] }).elements.length, 1)
  } finally {
    context.database.close()
  }
})

test('reconcile upgrades a story-managed image slot to a ready video with pinned source duration', () => {
  const context = fixture()
  try {
    const initial = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const initialClip = timelineTracks(initial.document).overlay[0].elements[0]
    assert.equal(initialClip.type, 'image')
    assert.equal(initialClip.sourceDuration, undefined)

    context.database.createMediaAsset({
      id: 'seedance-shot-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'shot.video',
      source: 'seedance',
      sourceRevisionId: context.sourceRevisionId,
      mimeType: 'video/mp4',
      durationSeconds: 5,
    })
    const changed = context.database.withSql((sql) => sql.run(`
      UPDATE shots SET video_asset_id = 'seedance-shot-1'
       WHERE json_extract(metadata_json, '$.storyId') = 'shot-1'
    `).changes)
    assert.equal(changed, 1)

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: initial.revision.id,
    })
    const clip = timelineTracks(reconciled.document).overlay[0].elements[0]
    assert.equal(clip.type, 'video')
    assert.equal(clip.sourceDuration, 600_000)
    assert.equal(clip.mediaId, 'seedance-shot-1')
    assert.equal(clip.params.assetId, undefined)
    assert.equal(clip.params.storyAssetId, 'seedance-shot-1')
  } finally {
    context.database.close()
  }
})

test('Agentic auto-edit conforms a short Seedance clip to its real speech envelope with only the locked same-shot storyboard', () => {
  const context = fixture()
  try {
    context.database.createMediaAsset({
      id: 'shot-1-locked-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'storyboard.image',
      source: 'fixture',
      sourceRevisionId: context.sourceRevisionId,
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      filePath: '/fixture/shot-1-locked-storyboard.png',
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'shot-1-locked-storyboard'
       WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = 'episode-1')
    `))
    bindSpeechAsset(context, 'line-1', 'speech-shot-1-seven-seconds', {
      durationSeconds: 7,
    })
    const initial = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })

    context.database.createMediaAsset({
      id: 'seedance-short-shot-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'shot.video',
      source: 'seedance',
      sourceRevisionId: context.sourceRevisionId,
      mimeType: 'video/mp4',
      durationSeconds: 3,
      checksum: 'b'.repeat(64),
      filePath: '/fixture/seedance-short-shot-1.mp4',
      generationParameters: { audioPolicy: 'silent', generateAudio: false },
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE shots SET video_asset_id = 'seedance-short-shot-1'
       WHERE json_extract(metadata_json, '$.storyId') = 'shot-1'
    `))

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: initial.revision.id,
    })
    const before = timelineTracks(reconciled.document).overlay[0].elements[0]!
    assert.equal(before.type, 'video')
    assert.equal(before.mediaId, 'seedance-short-shot-1')
    assert.equal(before.sourceDuration, 360_000)
    assert.equal(before.duration, 360_000)
    assert.deepEqual(before.manju?.shortVideoFill, {
      version: 1,
      strategy: 'same-shot-locked-image-hold-v1',
      fallbackAssetId: 'shot-1-locked-storyboard',
      storySceneId: 'scene-1',
      storyShotId: 'shot-1',
      sourceRevisionId: context.sourceRevisionId,
      sourceDurationTicks: 360_000,
      targetDurationTicks: 840_000,
      appliedByOpenCut: false,
      appliedPlanHash: null,
    })
    assert.equal(timelineTracks(reconciled.document).overlay[0].elements[1]!.startTime, 840_000)

    const autoEdit = new TimelineAutoEditService(
      context.database,
      context.timelines,
      new SQLiteTimelineAutoEditRepository(context.database),
      createTimelineMaterializationAutoEditPlanner(context.materialization, context.database),
      {
        idFactory: (() => {
          const ids = ['short-fill-plan', 'short-fill-application']
          return () => ids.shift() ?? 'unexpected-short-fill-id'
        })(),
        tokenFactory: () => `taec_${'s'.repeat(40)}`,
        now: () => '2026-07-15T00:00:00.000Z',
      },
    )
    const preview = autoEdit.preview({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: reconciled.revision.id,
      goal: 'exportable',
      policy: 'safe',
    })
    assert.equal(preview.plan.id, 'short-fill-plan')
    assert.equal(preview.risk, 'safe')
    assert.equal(preview.diagnostics.some((diagnostic) => (
      diagnostic.code === 'MANAGED_SHORT_VIDEO_SAME_SHOT_IMAGE_HOLD'
    )), true)
    assert.deepEqual(preview.operations.map((operation) => ({
      elementId: operation.elementId,
      reason: operation.reason,
      beforeDuration: operation.before.duration,
      afterDuration: operation.after.duration,
    })), [{
      elementId: before.id,
      reason: 'fill-short-managed-video-with-same-shot-image',
      beforeDuration: 360_000,
      afterDuration: 840_000,
    }])

    const application = autoEdit.apply({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: reconciled.revision.id,
      planId: preview.plan.id,
      confirmationToken: preview.plan.confirmationToken,
      idempotencyKey: 'short-fill-apply',
    })
    const after = timelineTracks(application.timeline.document).overlay[0].elements[0]!
    assert.equal(after.duration, 840_000)
    assert.equal((after.manju?.shortVideoFill as Record<string, unknown>)?.appliedByOpenCut, true)
    assert.match(String((after.manju?.shortVideoFill as Record<string, unknown>)?.appliedPlanHash), /^[0-9a-f]{64}$/)
    assert.equal(application.application.id, 'short-fill-application')
    assert.equal(application.application.planId, 'short-fill-plan')
    assert.equal(application.operations[0]?.reason, 'fill-short-managed-video-with-same-shot-image')

    const exported = new ExportRenderService(context.database, context.timelines).create({
      projectId: 'project-1',
      episodeId: 'episode-1',
      timelineRevisionId: application.timeline.revision.id,
      resolution: '720p',
      idempotencyKey: 'short-video-same-shot-fill',
    })
    assert.deepEqual(exported.export.timelineSnapshot.semanticPlan?.visualClips.slice(0, 2)
      .map((clip) => ({
        mediaType: clip.mediaType,
        assetId: clip.asset.assetId,
        durationFrames: clip.durationFrames,
      })), [{
      mediaType: 'video',
      assetId: 'seedance-short-shot-1',
      durationFrames: 72,
    }, {
      mediaType: 'image',
      assetId: 'shot-1-locked-storyboard',
      durationFrames: 96,
    }])

    const idempotent = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: application.timeline.revision.id,
      autoLayoutManagedDialogue: true,
    })
    assert.equal(idempotent.report.changed, false)
    assert.equal(idempotent.revision.id, application.timeline.revision.id)
    const replayed = timelineTracks(idempotent.document).overlay[0].elements[0]!
    assert.equal(replayed.duration, 840_000)
    assert.equal(
      (replayed.manju?.shortVideoFill as Record<string, unknown>)?.appliedByOpenCut,
      true,
    )
  } finally {
    context.database.close()
  }
})

test('a short video never replaces the timeline when the same-shot image lock is from another Story revision', () => {
  const context = fixture()
  try {
    context.database.createRevision({
      id: 'older-story-revision',
      projectId: 'project-1',
      summary: 'older storyboard source',
      snapshot: structuredClone(context.story) as unknown as JsonObject,
    })
    context.database.createMediaAsset({
      id: 'stale-shot-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'storyboard.image',
      source: 'fixture',
      sourceRevisionId: 'older-story-revision',
      mimeType: 'image/png',
      checksum: 'c'.repeat(64),
      filePath: '/fixture/stale-shot-storyboard.png',
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'stale-shot-storyboard'
       WHERE json_extract(metadata_json, '$.storyId') = 'shot-1'
    `))
    const initial = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    context.database.createMediaAsset({
      id: 'unsafe-short-video',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'shot.video',
      source: 'seedance',
      sourceRevisionId: context.sourceRevisionId,
      mimeType: 'video/mp4',
      durationSeconds: 3,
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE shots SET video_asset_id = 'unsafe-short-video'
       WHERE json_extract(metadata_json, '$.storyId') = 'shot-1'
    `))

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: initial.revision.id,
    })
    const clip = timelineTracks(reconciled.document).overlay[0].elements[0]!
    assert.equal(clip.type, 'image')
    assert.equal(clip.mediaId, 'stale-shot-storyboard')
    assert.equal(clip.manju?.shortVideoFill, undefined)
  } finally {
    context.database.close()
  }
})

test('legacy short video at the Story edit point is normalized before it can receive an audited fill', () => {
  const context = fixture()
  try {
    context.database.createMediaAsset({
      id: 'legacy-fill-storyboard', projectId: 'project-1', episodeId: 'episode-1',
      kind: 'storyboard.image', source: 'fixture', sourceRevisionId: context.sourceRevisionId,
      mimeType: 'image/png', checksum: 'd'.repeat(64),
      filePath: '/fixture/legacy-fill-storyboard.png',
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'legacy-fill-storyboard'
       WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = 'episode-1')
    `))
    const initial = context.materialization.materialize({
      projectId: 'project-1', episodeId: 'episode-1', expectedRevisionId: null,
    })
    context.database.createMediaAsset({
      id: 'legacy-short-video', projectId: 'project-1', episodeId: 'episode-1',
      kind: 'shot.video', source: 'seedance', sourceRevisionId: context.sourceRevisionId,
      mimeType: 'video/mp4', durationSeconds: 3, checksum: 'e'.repeat(64),
      filePath: '/fixture/legacy-short-video.mp4',
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE shots SET video_asset_id = 'legacy-short-video'
       WHERE json_extract(metadata_json, '$.storyId') = 'shot-1'
    `))

    const legacyDocument = structuredClone(initial.document)
    const legacyClip = timelineTracks(legacyDocument).overlay[0].elements[0]!
    legacyClip.type = 'video'
    legacyClip.mediaId = 'legacy-short-video'
    legacyClip.sourceDuration = 360_000
    legacyClip.duration = 600_000
    legacyClip.params.storyAssetId = 'legacy-short-video'
    delete legacyClip.manju?.shortVideoFill
    const legacyHead = context.timelines.save({
      projectId: 'project-1', episodeId: 'episode-1',
      expectedRevisionId: initial.revision.id,
      schemaVersion: 2, upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: 'legacy short video without fill audit', document: legacyDocument,
    })

    const normalized = context.materialization.reconcile({
      projectId: 'project-1', episodeId: 'episode-1',
      expectedRevisionId: legacyHead.revision.id,
    })
    const normalizedClip = timelineTracks(normalized.document).overlay[0].elements[0]!
    assert.equal(normalizedClip.duration, 360_000)
    assert.equal(
      (normalizedClip.manju?.shortVideoFill as Record<string, unknown>)?.appliedByOpenCut,
      false,
    )
    const candidate = context.materialization.planAutomaticEdit({
      projectId: 'project-1', episodeId: 'episode-1',
      expectedRevisionId: normalized.revision.id,
    })
    assert.equal(candidate.diagnostics.managedShortVideoFillOperations, 1)
    assert.equal(candidate.receipt?.operations[0]?.before.duration, 360_000)
    assert.equal(candidate.receipt?.operations[0]?.after.duration, 600_000)
    assert.equal(
      (timelineTracks(candidate.document).overlay[0].elements[0]!.manju
        ?.shortVideoFill as Record<string, unknown>)?.appliedByOpenCut,
      true,
    )
  } finally {
    context.database.close()
  }
})

test('reconcile enables Seedance SFX source audio without mixing it into dialogue assets', () => {
  const context = fixture()
  try {
    const initial = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    context.database.createMediaAsset({
      id: 'seedance-sfx-shot-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'shot.video',
      source: 'seedance',
      sourceRevisionId: context.sourceRevisionId,
      mimeType: 'video/mp4',
      durationSeconds: 5,
      generationParameters: {
        audioPolicy: 'sfx_only',
        generateAudio: true,
      },
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE shots SET video_asset_id = 'seedance-sfx-shot-1'
       WHERE json_extract(metadata_json, '$.storyId') = 'shot-1'
    `))

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: initial.revision.id,
    })
    const clip = timelineTracks(reconciled.document).overlay[0].elements[0]
    assert.equal(clip.type, 'video')
    assert.equal(clip.isSourceAudioEnabled, true)
    assert.equal(clip.params.audioRole, 'sfx')
    assert.equal(timelineTracks(reconciled.document).audio.length, 0)

    const editedDocument = structuredClone(reconciled.document)
    timelineTracks(editedDocument).overlay[0].elements[0].isSourceAudioEnabled = false
    const edited = context.timelines.saveReconciled({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: reconciled.revision.id,
      schemaVersion: reconciled.timelineDocument.schemaVersion,
      upstreamCommit: reconciled.timelineDocument.upstreamCommit,
      sourceRevisionId: context.sourceRevisionId,
      summary: '用户静音 Seedance 环境音',
      document: editedDocument,
    })
    const preserved = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: edited.revision.id,
    })
    assert.equal(
      timelineTracks(preserved.document).overlay[0].elements[0].isSourceAudioEnabled,
      false,
    )
  } finally {
    context.database.close()
  }
})

test('reconcile safely migrates persisted v1 aliases into canonical v2 union fields', () => {
  const context = fixture()
  try {
    context.database.createMediaAsset({
      id: 'legacy-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'storyboard',
      source: 'fixture',
      sourceRevisionId: context.sourceRevisionId,
      mimeType: 'image/png',
    })
    context.database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'legacy-storyboard'
      WHERE json_extract(metadata_json, '$.storyId') = 'shot-1'
    `))
    bindSpeechAsset(context, 'line-1', 'legacy-speech', { durationSeconds: 1 })
    const legacy = context.timelines.saveReconciled({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: context.sourceRevisionId,
      document: {
        version: 1,
        editor: 'OpenCut-Classic',
        upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
        ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
        tracks: {
          overlay: [{
            id: 'legacy-visual',
            type: 'video',
            elements: [{
              id: 'legacy-image',
              type: 'image',
              startTime: 0,
              duration: 600_000,
              params: {
                assetId: 'legacy-storyboard',
                storyAssetId: 'legacy-storyboard',
                storySceneId: 'scene-1',
                storyShotId: 'shot-1',
              },
            }],
          }],
          main: { id: 'main', type: 'video', elements: [] },
          audio: [{
            id: 'legacy-dialogue',
            type: 'audio',
            elements: [{
              id: 'legacy-audio',
              type: 'audio',
              startTime: 0,
              duration: 120_000,
              params: {
                assetId: 'legacy-speech',
                storyManagedAssetId: 'legacy-speech',
                storySceneId: 'scene-1',
                storyShotId: 'shot-1',
                dialogueLineId: 'line-1',
              },
            }],
          }],
        },
      },
    })

    const migrated = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: legacy.revision.id,
    })
    const tracks = timelineTracks(migrated.document)
    const visual = tracks.overlay[0].elements[0]
    const audio = (tracks.audio[0] as unknown as {
      name: string
      muted: boolean
      elements: Array<{
        mediaId: string
        sourceType: string
        params: Record<string, unknown>
      }>
    }).elements[0]

    assert.equal(migrated.report.changed, true)
    assert.equal(migrated.timelineDocument.schemaVersion, 2)
    assert.equal(migrated.revision.schemaVersion, 2)
    assert.equal(migrated.document.version, 2)
    assert.equal(visual.mediaId, 'legacy-storyboard')
    assert.equal(visual.params.assetId, undefined)
    assert.equal(tracks.overlay[0].name, 'legacy-visual')
    assert.equal(tracks.overlay[0].hidden, false)
    assert.equal(tracks.overlay[0].muted, false)
    assert.equal(audio.sourceType, 'upload')
    assert.equal(audio.mediaId, 'legacy-speech')
    assert.equal(audio.params.assetId, undefined)
  } finally {
    context.database.close()
  }
})

test('reconcile upgrades the deployed v1 local-shot manifest shape without losing clips', () => {
  const context = fixture()
  try {
    context.database.createMediaAsset({
      id: 'ready-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'storyboard',
      source: 'fixture',
      sourceRevisionId: context.sourceRevisionId,
      mimeType: 'image/png',
    })
    const bound = context.database.withSql((sql) => sql.run(`
      UPDATE shots SET storyboard_asset_id = 'ready-storyboard'
      WHERE json_extract(metadata_json, '$.storyId') = 'shot-1'
    `).changes)
    assert.equal(bound, 1)

    const legacy = context.timelines.saveReconciled({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
      schemaVersion: 1,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      sourceRevisionId: context.sourceRevisionId,
      summary: 'deployed v1 fixture',
      document: {
        version: 1,
        editor: 'OpenCut-Classic',
        upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
        ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
        frameRate: { numerator: 24, denominator: 1 },
        tracks: {
          overlay: [{
            id: 'visual-main',
            type: 'video',
            elements: context.story.scenes[0].shots.map((shot, index) => ({
              id: `shot-${index + 1}`,
              type: 'image',
              name: shot.code,
              startTime: index * 600_000,
              duration: Math.round(shot.durationSeconds * OPEN_CUT_TICKS_PER_SECOND),
              trimStart: 0,
              trimEnd: 0,
              params: { shotId: String(index + 1) },
            })),
          }],
          main: { id: 'main', type: 'video', elements: [] },
          audio: [],
        },
        manjuTimeline: {
          adapterVersion: 1,
          sourceRevisionId: context.sourceRevisionId,
          storyShots: context.story.scenes[0].shots.map((shot) => ({
            sceneId: 'scene-1',
            shotId: shot.id,
          })),
          dialogueLines: [],
        },
        sourceRevisionId: context.sourceRevisionId,
      },
    })

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: legacy.revision.id,
    })
    const elements = timelineTracks(reconciled.document).overlay[0].elements

    assert.equal(reconciled.timelineDocument.schemaVersion, 2)
    assert.equal(reconciled.document.version, 2)
    assert.deepEqual(
      reconciled.report.preservedElementIds,
      context.story.scenes[0].shots.map((_, index) => `shot-${index + 1}`),
    )
    assert.deepEqual(reconciled.report.appendedShots, [])
    assert.equal(elements[0].params.storySceneId, 'scene-1')
    assert.equal(elements[0].params.storyShotId, 'shot-1')
    assert.equal(elements[0].mediaId, 'ready-storyboard')
    assert.equal(elements[0].manju, undefined)
    assert.equal(elements[1].params.storySceneId, 'scene-1')
    assert.equal(elements[1].params.storyShotId, 'shot-2')
    assert.equal(elements[1].mediaId, 'manju:pending:shot-2')
    assert.equal(elements[1].manju?.mediaBindingState, 'unresolved')
  } finally {
    context.database.close()
  }
})

test('reconcile preserves edits and unknown fields, appends only new shots, and retains deleted shots as orphans', () => {
  const context = fixture()
  try {
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    assert.deepEqual(timelineTracks(materialized.document).audio, [])
    const editedDocument = structuredClone(materialized.document)
    const editedTracks = timelineTracks(editedDocument)
    const elements = editedTracks.overlay[0].elements
    const first = elements[0]
    first.duration = 240_000
    first.trimStart = 10_000
    first.futureOpenCutField = {
      effect: 'preserve-me',
      values: [1, true, null],
    }
    const splitRight = structuredClone(first)
    splitRight.id = 'user-split-right'
    splitRight.startTime = 240_000
    splitRight.duration = 360_000
    splitRight.trimStart = 250_000
    elements.splice(1, 0, splitRight)
    const intentionallyRemoved = elements.findIndex((element) => (
      element.params.storyShotId === 'shot-2'
    ))
    assert.notEqual(intentionallyRemoved, -1)
    elements.splice(intentionallyRemoved, 1)
    editedDocument.futureOpenCutExtension = {
      masks: [{ kind: 'future-shape', feather: 0.7 }],
    }
    const edited = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: '用户裁切、分割并删除一个片段',
      document: editedDocument,
    })

    const afterDelete = context.stories.deleteShot('episode-1', 'shot-7')
    const afterCreate = context.stories.createShot('episode-1', 'scene-1', {
      id: 'shot-8',
      code: 'S8',
      title: '新增镜头',
      description: '剧本修订后新增。',
      framing: '特写',
      movement: '推镜',
      transition: '硬切',
      durationSeconds: 3,
      visualPrompt: 'new shot',
      dialogueLines: [],
    }, { expectedRevisionId: afterDelete.revision.id })

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: edited.revision.id,
    })
    const reconciledElements = timelineTracks(reconciled.document).overlay[0].elements
    const preservedLeft = reconciledElements.find((element) => element.id === first.id)
    const preservedRight = reconciledElements.find((element) => element.id === splitRight.id)
    const orphan = reconciledElements.find((element) => (
      element.params.storyShotId === 'shot-7'
    ))
    const appended = reconciledElements.find((element) => (
      element.params.storyShotId === 'shot-8'
    ))

    assert.ok(preservedLeft)
    assert.ok(preservedRight)
    assert.equal(preservedLeft.duration, 240_000)
    assert.equal(preservedLeft.trimStart, 10_000)
    assert.deepEqual(preservedLeft.futureOpenCutField, {
      effect: 'preserve-me',
      values: [1, true, null],
    })
    assert.equal(preservedRight.duration, 360_000)
    assert.equal(preservedRight.trimStart, 250_000)
    assert.ok(orphan)
    assert.equal(orphan.params.storyOrphaned, true)
    assert.equal(orphan.params.orphanedAtSourceRevisionId, afterCreate.revision.id)
    assert.ok(appended)
    assert.equal(appended.startTime, 3_960_000)
    assert.equal(appended.duration, 360_000)
    assert.equal(reconciledElements.some((element) => (
      element.params.storyShotId === 'shot-2'
    )), false)
    assert.deepEqual(reconciled.document.futureOpenCutExtension, {
      masks: [{ kind: 'future-shape', feather: 0.7 }],
    })
    assert.equal(reconciled.timelineDocument.sourceRevisionId, afterCreate.revision.id)
    assert.equal(reconciled.revision.parentRevisionId, edited.revision.id)
    assert.equal(reconciled.report.changed, true)
    assert.deepEqual(reconciled.report.appendedShots.map((shot) => shot.shotId), ['shot-8'])
    assert.deepEqual(reconciled.report.preservedAbsentShots.map((shot) => shot.shotId), ['shot-2'])
    assert.deepEqual(reconciled.report.orphanedElements.map((element) => element.shotId), ['shot-7'])
    assert.ok(reconciled.report.preservedElementIds.includes(first.id))
    assert.ok(reconciled.report.preservedElementIds.includes(splitRight.id))
    assert.equal(context.timelines.listRevisions(materialized.timelineDocument.id).revisions.length, 3)

    assert.throws(() => context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: edited.revision.id,
    }), isTimelineError('TIMELINE_DOCUMENT_CONFLICT'))
    assert.equal(context.timelines.listRevisions(materialized.timelineDocument.id).revisions.length, 3)

    const noOp = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: reconciled.revision.id,
    })
    assert.equal(noOp.report.changed, false)
    assert.equal(noOp.revision.id, reconciled.revision.id)
    assert.equal(context.timelines.listRevisions(materialized.timelineDocument.id).revisions.length, 3)
  } finally {
    context.database.close()
  }
})

test('speech reconcile appends a newly generated asset once, respects deletion, and clears stale managed refs', () => {
  const context = fixture()
  try {
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    assert.deepEqual(timelineTracks(materialized.document).audio, [])

    bindSpeechAsset(context, 'line-1', 'speech-first', { durationSeconds: 1 })
    const withSpeech = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
    })
    const firstAudioTrack = timelineTracks(withSpeech.document).audio[0] as unknown as {
      id: string
      elements: Array<{
        id: string
        startTime: number
        duration: number
        mediaId: string
        sourceType: string
        params: Record<string, unknown>
      }>
    }
    assert.equal(firstAudioTrack.id, 'dialogue-main')
    assert.equal(firstAudioTrack.elements.length, 1)
    assert.equal(firstAudioTrack.elements[0].startTime, 0)
    assert.equal(firstAudioTrack.elements[0].duration, 120_000)
    assert.equal(firstAudioTrack.elements[0].sourceType, 'upload')
    assert.equal(firstAudioTrack.elements[0].mediaId, 'speech-first')
    assert.equal(firstAudioTrack.elements[0].params.assetId, undefined)
    assert.equal(withSpeech.report.appendedDialogueAudio.length, 1)

    const userDeletedDocument = structuredClone(withSpeech.document)
    const deletedAudioTrack = timelineTracks(userDeletedDocument).audio[0] as unknown as {
      elements: unknown[]
    }
    deletedAudioTrack.elements.splice(0)
    const userDeleted = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: withSpeech.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: '用户主动删除台词音频',
      document: userDeletedDocument,
    })
    const deletionPreserved = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: userDeleted.revision.id,
    })
    const preservedTrack = timelineTracks(deletionPreserved.document).audio[0] as unknown as {
      elements: unknown[]
    }
    assert.deepEqual(preservedTrack.elements, [])
    assert.deepEqual(
      deletionPreserved.report.preservedAbsentDialogueLines.map((line) => line.dialogueLineId),
      ['line-1'],
    )
    assert.equal(deletionPreserved.report.changed, true)
    assert.notEqual(deletionPreserved.revision.id, userDeleted.revision.id)
    assert.equal(
      timelineMediaAuthorityReceipt(context.database, userDeleted.revision.id),
      null,
    )
    assert.equal(
      timelineMediaAuthorityReceipt(context.database, deletionPreserved.revision.id)?.fingerprint,
      mediaAuthorityFingerprint(deletionPreserved.document),
    )
    const deletionNoOp = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: deletionPreserved.revision.id,
    })
    assert.equal(deletionNoOp.report.changed, false)
    assert.equal(deletionNoOp.revision.id, deletionPreserved.revision.id)

    bindSpeechAsset(context, 'line-1', 'speech-regenerated', { durationSeconds: 1.5 })
    const regenerated = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: deletionPreserved.revision.id,
    })
    const regeneratedTrack = timelineTracks(regenerated.document).audio[0] as unknown as {
      elements: Array<{ mediaId: string; params: Record<string, unknown> }>
    }
    assert.equal(regeneratedTrack.elements.length, 1)
    assert.equal(regeneratedTrack.elements[0].mediaId, 'speech-regenerated')
    assert.equal(regeneratedTrack.elements[0].params.assetId, undefined)
    assert.equal(regeneratedTrack.elements[0].params.storyManagedAssetId, 'speech-regenerated')

    const manuallyReplacedDocument = structuredClone(regenerated.document)
    const manualElement = (timelineTracks(manuallyReplacedDocument).audio[0] as unknown as {
      elements: Array<{
        mediaId: string
        params: Record<string, unknown>
        futureAudioField?: unknown
      }>
    }).elements[0]
    manualElement.mediaId = 'manual-audio-asset'
    manualElement.futureAudioField = { keep: true }
    const manuallyReplaced = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: regenerated.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: '用户手工替换音频',
      document: manuallyReplacedDocument,
    })
    context.database.updateMediaAsset('speech-regenerated', { status: 'stale' })

    const staleReconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: manuallyReplaced.revision.id,
    })
    const staleElement = (timelineTracks(staleReconciled.document).audio[0] as unknown as {
      elements: Array<{
        mediaId: string
        params: Record<string, unknown>
        futureAudioField?: unknown
      }>
    }).elements[0]
    assert.equal(staleElement.mediaId, 'manual-audio-asset')
    assert.equal(staleElement.params.assetId, undefined)
    assert.equal(staleElement.params.storyManagedAssetId, undefined)
    assert.equal(staleElement.params.dialogueOrphaned, true)
    assert.deepEqual(staleElement.futureAudioField, { keep: true })
    assert.deepEqual(staleReconciled.report.speechConflicts.map((conflict) => conflict.code), [
      'SPEECH_ASSET_NOT_READY',
    ])
  } finally {
    context.database.close()
  }
})

test('story duration reconcile ripples untouched clips but reports and preserves user timing edits', () => {
  const context = fixture()
  try {
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const firstStoryEdit = context.stories.updateShot('episode-1', 'shot-1', {
      durationSeconds: 6,
    })
    const automaticallyUpdated = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
    })
    const automaticElements = timelineTracks(automaticallyUpdated.document).overlay[0].elements
    assert.equal(automaticElements[0].duration, 720_000)
    assert.deepEqual(automaticElements.slice(1).map((element) => element.startTime), [
      720_000,
      1_320_000,
      1_920_000,
      2_520_000,
      3_120_000,
      3_720_000,
    ])
    assert.equal(automaticallyUpdated.timelineDocument.sourceRevisionId, firstStoryEdit.revision.id)
    assert.deepEqual(automaticallyUpdated.report.updatedShotTimings, [{
      sceneId: 'scene-1',
      shotId: 'shot-1',
      elementId: automaticElements[0].id,
      previousDuration: 600_000,
      nextDuration: 720_000,
      rippledElementIds: automaticElements.slice(1).map((element) => element.id),
    }])

    const userEditedDocument = structuredClone(automaticallyUpdated.document)
    const userElements = timelineTracks(userEditedDocument).overlay[0].elements
    const shot2 = userElements.find((element) => element.params.storyShotId === 'shot-2')!
    const shot2Right = structuredClone(shot2)
    shot2.duration = 300_000
    shot2Right.id = 'shot-2-user-split'
    shot2Right.startTime += 300_000
    shot2Right.duration = 300_000
    userElements.splice(userElements.indexOf(shot2) + 1, 0, shot2Right)
    const shot3 = userElements.find((element) => element.params.storyShotId === 'shot-3')!
    shot3.trimStart = 5_000
    const shot4 = userElements.find((element) => element.params.storyShotId === 'shot-4')!
    shot4.startTime += 5_000
    const shot5 = userElements.find((element) => element.params.storyShotId === 'shot-5')!
    shot5.duration += 5_000
    const userEdited = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: automaticallyUpdated.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: '用户分割、裁切、移动并改长片段',
      document: userEditedDocument,
    })

    context.stories.updateShot('episode-1', 'shot-2', { durationSeconds: 5.5 })
    context.stories.updateShot('episode-1', 'shot-3', { durationSeconds: 4.5 })
    context.stories.updateShot('episode-1', 'shot-4', { durationSeconds: 5.5 })
    const finalStoryEdit = context.stories.updateShot('episode-1', 'shot-5', {
      durationSeconds: 4.5,
    })
    const preserved = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: userEdited.revision.id,
    })
    const preservedElements = timelineTracks(preserved.document).overlay[0].elements
    assert.equal(
      preservedElements.filter((element) => element.params.storyShotId === 'shot-2').length,
      2,
    )
    assert.equal(
      preservedElements.find((element) => element.params.storyShotId === 'shot-3')!.trimStart,
      5_000,
    )
    assert.equal(
      preservedElements.find((element) => element.params.storyShotId === 'shot-4')!.startTime,
      shot4.startTime,
    )
    assert.equal(
      preservedElements.find((element) => element.params.storyShotId === 'shot-5')!.duration,
      shot5.duration,
    )
    assert.deepEqual(
      preserved.report.preservedShotTimings.map((timing) => [timing.shotId, timing.reason]),
      [
        ['shot-2', 'split'],
        ['shot-3', 'trimmed'],
        ['shot-4', 'moved'],
        ['shot-5', 'duration-edited'],
      ],
    )
    assert.equal(preserved.report.updatedShotTimings.length, 0)
    assert.equal(preserved.timelineDocument.sourceRevisionId, finalStoryEdit.revision.id)
  } finally {
    context.database.close()
  }
})

test('speech reconcile preserves split and manual edits, updates regenerated assets, and orphans lost lines', () => {
  const story = generatedStory()
  story.scenes[0].shots[0].dialogueLines = [{
    id: 'line-1', sequence: 0, kind: 'dialogue', speaker: '阿离', text: '第一句。',
  }, {
    id: 'line-2', sequence: 1, kind: 'dialogue', speaker: '阿离', text: '第二句。',
  }]
  story.scenes[0].shots[1].dialogueLines = [{
    id: 'line-3', sequence: 0, kind: 'dialogue', speaker: '阿离', text: '第三句。',
  }]
  story.scenes[0].shots[2].dialogueLines = [{
    id: 'line-4', sequence: 0, kind: 'dialogue', speaker: '阿离', text: '将被删除。',
  }]
  const context = fixture(story)
  try {
    for (const lineId of ['line-1', 'line-2', 'line-3', 'line-4']) {
      bindSpeechAsset(context, lineId, `${lineId}-old`, { durationSeconds: 1 })
    }
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const initialAudio = (timelineTracks(materialized.document).audio[0] as unknown as {
      elements: Array<{
        id: string
        startTime: number
        duration: number
        params: Record<string, unknown>
        futureAudioField?: unknown
      }>
    }).elements
    assert.deepEqual(initialAudio.map((element) => [
      element.params.dialogueLineId,
      element.startTime,
    ]), [
      ['line-1', 0],
      ['line-2', 120_000],
      ['line-3', 240_000],
      ['line-4', 360_000],
    ])

    const editedDocument = structuredClone(materialized.document)
    const editedAudio = (timelineTracks(editedDocument).audio[0] as unknown as {
      elements: Array<{
        id: string
        startTime: number
        duration: number
        trimStart?: number
        mediaId: string
        manju?: Record<string, unknown>
        params: Record<string, unknown>
        futureAudioField?: unknown
      }>
    }).elements
    const line1 = editedAudio.find((element) => element.params.dialogueLineId === 'line-1')!
    const line1Right = structuredClone(line1)
    line1.duration = 60_000
    line1.futureAudioField = { preserve: 'left' }
    line1Right.id = 'line-1-user-split'
    line1Right.startTime += 60_000
    line1Right.duration = 60_000
    line1Right.trimStart = 60_000
    line1Right.futureAudioField = { preserve: 'right' }
    editedAudio.splice(editedAudio.indexOf(line1) + 1, 0, line1Right)
    const line2 = editedAudio.find((element) => element.params.dialogueLineId === 'line-2')!
    line2.mediaId = 'manual-line-2-audio'
    const edited = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: '用户分割并替换台词音频',
      document: editedDocument,
    })

    const shot2 = structuredClone(context.stories.getStory('episode-1')!.scenes[0].shots[1])
    shot2.dialogueLines.push({
      id: 'line-6', sequence: 1, kind: 'dialogue', speaker: '阿离', text: '新生成台词。',
    })
    context.stories.updateShot('episode-1', 'shot-2', {
      dialogueLines: shot2.dialogueLines,
    })
    context.stories.updateShot('episode-1', 'shot-3', { dialogueLines: [] })
    bindSpeechAsset(context, 'line-1', 'line-1-new', { durationSeconds: 1 })
    bindSpeechAsset(context, 'line-2', 'line-2-new', { durationSeconds: 1 })
    bindSpeechAsset(context, 'line-6', 'line-6-new', { durationSeconds: 1.5 })

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: edited.revision.id,
    })
    const reconciledAudio = (timelineTracks(reconciled.document).audio[0] as unknown as {
      elements: Array<{
        id: string
        startTime: number
        duration: number
        mediaId: string
        manju?: Record<string, unknown>
        params: Record<string, unknown>
        futureAudioField?: unknown
      }>
    }).elements
    const line1Elements = reconciledAudio.filter((element) => (
      element.params.dialogueLineId === 'line-1'
    ))
    assert.equal(line1Elements.length, 2)
    assert.ok(line1Elements.every((element) => element.mediaId === 'line-1-new'))
    assert.ok(line1Elements.every((element) => element.params.assetId === undefined))
    assert.ok(line1Elements.every((element) => (
      element.params.storyManagedAssetId === 'line-1-new'
    )))
    assert.deepEqual(line1Elements.map((element) => element.futureAudioField), [
      { preserve: 'left' },
      { preserve: 'right' },
    ])
    const line2Element = reconciledAudio.find((element) => (
      element.params.dialogueLineId === 'line-2'
    ))!
    assert.equal(line2Element.mediaId, 'manual-line-2-audio')
    assert.equal(line2Element.params.assetId, undefined)
    assert.equal(line2Element.params.storyManagedAssetId, 'line-2-new')
    const line3Element = reconciledAudio.find((element) => (
      element.params.dialogueLineId === 'line-3'
    ))!
    assert.equal(line3Element.params.dialogueOrphaned, true)
    assert.equal(line3Element.params.dialogueOrphanReason, 'speech-asset-missing')
    assert.equal(line3Element.mediaId, `manju:pending:${encodeURIComponent(line3Element.id)}`)
    assert.equal(line3Element.manju?.mediaBindingState, 'unresolved')
    assert.equal(line3Element.params.assetId, undefined)
    const line4Element = reconciledAudio.find((element) => (
      element.params.dialogueLineId === 'line-4'
    ))!
    assert.equal(line4Element.params.dialogueOrphaned, true)
    assert.equal(line4Element.params.dialogueOrphanReason, 'dialogue-line-deleted')
    assert.equal(line4Element.mediaId, `manju:pending:${encodeURIComponent(line4Element.id)}`)
    assert.equal(line4Element.manju?.mediaBindingState, 'unresolved')
    assert.equal(line4Element.params.assetId, undefined)
    const line6Element = reconciledAudio.find((element) => (
      element.params.dialogueLineId === 'line-6'
    ))!
    assert.equal(line6Element.startTime, 480_000)
    assert.equal(line6Element.duration, 180_000)
    assert.equal(line6Element.mediaId, 'line-6-new')
    assert.equal(line6Element.params.assetId, undefined)
    assert.deepEqual(reconciled.report.appendedDialogueAudio.map((line) => line.dialogueLineId), [
      'line-6',
    ])
    assert.deepEqual(
      reconciled.report.orphanedAudioElements.map((element) => [
        element.dialogueLineId,
        element.reason,
      ]),
      [
        ['line-3', 'speech-asset-missing'],
        ['line-4', 'dialogue-line-deleted'],
      ],
    )

    const noDuplicate = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: reconciled.revision.id,
    })
    const noDuplicateAudio = (timelineTracks(noDuplicate.document).audio[0] as unknown as {
      elements: Array<{ params: Record<string, unknown> }>
    }).elements
    assert.equal(noDuplicateAudio.filter((element) => (
      element.params.dialogueLineId === 'line-6'
    )).length, 1)
    assert.equal(noDuplicate.report.appendedDialogueAudio.length, 0)
    assert.equal(noDuplicate.report.changed, false)
    assert.equal(noDuplicate.revision.id, reconciled.revision.id)
  } finally {
    context.database.close()
  }
})

test('reviewed storyboard selection refuses to bless a conflicting manual visual override', () => {
  const context = fixture()
  try {
    createStoryboardCandidate(
      context,
      'storyboard-authority-a',
      'a',
      '2026-07-15T01:00:00.000Z',
    )
    createStoryboardCandidate(
      context,
      'storyboard-authority-b',
      'b',
      '2026-07-15T01:01:00.000Z',
    )
    createStoryboardCandidate(
      context,
      'storyboard-manual-c',
      'c',
      '2026-07-15T01:02:00.000Z',
    )
    selectStoryboard(context, 'storyboard-authority-a')
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    assert.ok(timelineMediaAuthorityReceipt(context.database, materialized.revision.id))

    const overriddenDocument = structuredClone(materialized.document)
    const overriddenVisual = timelineTracks(overriddenDocument).overlay[0].elements
      .find((element) => element.params.storyShotId === 'shot-1')!
    assert.equal(overriddenVisual.mediaId, 'storyboard-authority-a')
    overriddenVisual.mediaId = 'storyboard-manual-c'
    const overridden = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
      schemaVersion: materialized.revision.schemaVersion,
      upstreamCommit: materialized.revision.upstreamCommit,
      summary: '手工覆盖为 C',
      document: overriddenDocument,
    })
    assert.equal(mediaAuthorityFingerprint(overridden.document), null)
    assert.equal(timelineMediaAuthorityReceipt(context.database, overridden.revision.id), null)

    const reviews = new ShotMediaReviewService(context.database, {
      now: () => '2026-07-15T02:00:00.000Z',
      idFactory: () => 'review-select-authority-b',
    })
    const listed = reviews.list({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      mediaType: 'storyboard',
    })
    reviews.decide({
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      mediaType: 'storyboard',
      decision: 'adopt',
      assetId: 'storyboard-authority-b',
      expectedEpisodeVersion: versionTokenFromEtag(listed.episodeEtag)!,
      idempotencyKey: 'select-authority-b',
    })
    const revisionCount = context.timelines.listRevisions(
      materialized.timelineDocument.id,
      { limit: 100 },
    ).revisions.length
    const receiptCount = context.database.withSql((sql) => sql.all(`
      SELECT timeline_revision_id FROM timeline_media_authority_receipts
    `)).length

    assert.throws(() => context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: overridden.revision.id,
    }), (error: unknown) => error instanceof TimelineMaterializationError
      && error.code === 'TIMELINE_MEDIA_RECONCILIATION_REQUIRED')
    assert.equal(context.timelines.get('episode-1').revision.id, overridden.revision.id)
    assert.equal(context.timelines.listRevisions(
      materialized.timelineDocument.id,
      { limit: 100 },
    ).revisions.length, revisionCount)
    assert.equal(context.database.withSql((sql) => sql.all(`
      SELECT timeline_revision_id FROM timeline_media_authority_receipts
    `)).length, receiptCount)
    assert.equal(timelineMediaAuthorityReceipt(context.database, overridden.revision.id), null)
  } finally {
    context.database.close()
  }
})

test('unreviewed manual visual override drops stale trust once and then becomes a no-op', () => {
  const context = fixture()
  try {
    createStoryboardCandidate(
      context,
      'storyboard-current-a',
      'a',
      '2026-07-15T03:00:00.000Z',
    )
    createStoryboardCandidate(
      context,
      'storyboard-manual-c',
      'c',
      '2026-07-15T03:01:00.000Z',
    )
    selectStoryboard(context, 'storyboard-current-a')
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const overriddenDocument = structuredClone(materialized.document)
    const overriddenVisual = timelineTracks(overriddenDocument).overlay[0].elements
      .find((element) => element.params.storyShotId === 'shot-1')!
    overriddenVisual.mediaId = 'storyboard-manual-c'
    const authorityFingerprint = mediaAuthorityFingerprint(materialized.document)
    assert.equal(typeof authorityFingerprint, 'string')
    // Simulate a legacy/internal trusted writer that stamped the DB authority
    // without checking what the visible timeline element actually consumes.
    // Reconcile must downgrade this conflicting head rather than perpetuate it.
    const overridden = context.timelines.saveReconciled({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
      schemaVersion: materialized.revision.schemaVersion,
      upstreamCommit: materialized.revision.upstreamCommit,
      sourceRevisionId: context.sourceRevisionId,
      mediaAuthorityFingerprint: authorityFingerprint!,
      summary: '未审片的手工视觉覆盖',
      document: overriddenDocument,
    })
    assert.equal(
      timelineMediaAuthorityReceipt(context.database, overridden.revision.id)?.fingerprint,
      authorityFingerprint,
    )
    const beforeCount = context.timelines.listRevisions(
      materialized.timelineDocument.id,
      { limit: 100 },
    ).revisions.length

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: overridden.revision.id,
    })
    const reconciledVisual = timelineTracks(reconciled.document).overlay[0].elements
      .find((element) => element.params.storyShotId === 'shot-1')!
    assert.equal(reconciled.report.changed, true)
    assert.notEqual(reconciled.revision.id, overridden.revision.id)
    assert.equal(reconciledVisual.mediaId, 'storyboard-manual-c')
    assert.equal(mediaAuthorityFingerprint(reconciled.document), null)
    assert.equal(timelineMediaAuthorityReceipt(context.database, reconciled.revision.id), null)
    assert.equal(context.timelines.listRevisions(
      materialized.timelineDocument.id,
      { limit: 100 },
    ).revisions.length, beforeCount + 1)

    const noOp = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: reconciled.revision.id,
    })
    assert.equal(noOp.report.changed, false)
    assert.equal(noOp.revision.id, reconciled.revision.id)
    assert.equal(mediaAuthorityFingerprint(noOp.document), null)
    assert.equal(timelineMediaAuthorityReceipt(context.database, noOp.revision.id), null)
    assert.equal(context.timelines.listRevisions(
      materialized.timelineDocument.id,
      { limit: 100 },
    ).revisions.length, beforeCount + 1)
  } finally {
    context.database.close()
  }
})

test('reconcile ignores stale visual links and removes only the story-managed asset reference', () => {
  const context = fixture()
  try {
    for (const [shotId, assetId] of [
      ['shot-1', 'storyboard-stale-manual'],
      ['shot-2', 'storyboard-stale-managed'],
    ] as const) {
      context.database.createMediaAsset({
        id: assetId,
        projectId: 'project-1',
        episodeId: 'episode-1',
        kind: 'storyboard',
        source: 'fixture',
        sourceRevisionId: context.sourceRevisionId,
        mimeType: 'image/png',
      })
      context.database.withSql((sql) => sql.run(`
        UPDATE shots SET storyboard_asset_id = ?
        WHERE json_extract(metadata_json, '$.storyId') = ?
      `, assetId, shotId))
    }
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const userDocument = structuredClone(materialized.document)
    const visualElements = timelineTracks(userDocument).overlay[0].elements
    const manual = visualElements.find((element) => element.params.storyShotId === 'shot-1')!
    manual.mediaId = 'user-selected-image'
    const userSaved = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: '用户替换一个视觉素材',
      document: userDocument,
    })
    context.database.updateMediaAsset('storyboard-stale-manual', { status: 'stale' })
    context.database.updateMediaAsset('storyboard-stale-managed', { status: 'stale' })

    const reconciled = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: userSaved.revision.id,
    })
    const nextElements = timelineTracks(reconciled.document).overlay[0].elements
    const manualNext = nextElements.find((element) => element.params.storyShotId === 'shot-1')!
    assert.equal(manualNext.mediaId, 'user-selected-image')
    assert.equal(manualNext.params.assetId, undefined)
    assert.equal(manualNext.params.storyAssetId, undefined)
    const managedNext = nextElements.find((element) => element.params.storyShotId === 'shot-2')!
    assert.equal(managedNext.mediaId, `manju:pending:${encodeURIComponent(managedNext.id)}`)
    assert.equal(managedNext.manju?.mediaBindingState, 'unresolved')
    assert.equal(managedNext.params.assetId, undefined)
    assert.equal(managedNext.params.storyAssetId, undefined)
  } finally {
    context.database.close()
  }
})

test('speech materialization refuses unknown duration and reports full audio that exceeds its shot', () => {
  const story = generatedStory()
  story.scenes[0].shots[0].dialogueLines = [{
    id: 'line-no-duration', sequence: 0, kind: 'dialogue', speaker: '阿离', text: '未知时长。',
  }, {
    id: 'line-overflow', sequence: 1, kind: 'dialogue', speaker: '阿离', text: '超出镜头。',
  }]
  const context = fixture(story)
  try {
    bindSpeechAsset(context, 'line-no-duration', 'speech-no-duration', {
      durationSeconds: null,
      lineDurationSeconds: null,
    })
    bindSpeechAsset(context, 'line-overflow', 'speech-overflow', {
      durationSeconds: 6,
    })
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const audioElements = (timelineTracks(materialized.document).audio[0] as unknown as {
      elements: Array<{
        startTime: number
        duration: number
        params: Record<string, unknown>
      }>
    }).elements
    assert.equal(audioElements.length, 1)
    assert.equal(audioElements[0].params.dialogueLineId, 'line-overflow')
    assert.equal(audioElements[0].startTime, 0)
    assert.equal(audioElements[0].duration, 720_000)
    assert.deepEqual(materialized.report.speechConflicts.map((conflict) => [
      conflict.dialogueLineId,
      conflict.code,
      conflict.blocking,
    ]), [
      ['line-no-duration', 'SPEECH_DURATION_MISSING', true],
      ['line-overflow', 'SPEECH_OVERFLOWS_SHOT', false],
    ])
  } finally {
    context.database.close()
  }
})

test('pipeline auto-layout repacks asynchronously arrived managed dialogue in Story order without truncation', () => {
  const story = generatedStory()
  story.scenes[0].shots.forEach((shot, index) => {
    shot.dialogueLines = index < 3 ? [{
      id: `line-${index + 1}`,
      sequence: 0,
      kind: 'dialogue',
      speaker: '阿离',
      text: `第 ${index + 1} 句。`,
    }] : []
  })
  const context = fixture(story)
  try {
    context.database.createMediaAsset({
      id: 'shared-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'storyboard.image',
      status: 'ready',
      source: 'fixture',
      sourceRevisionId: context.sourceRevisionId,
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      filePath: '/fixture/shared-storyboard.png',
    })
    context.database.withSql((sql) => sql.run(
      `UPDATE shots SET storyboard_asset_id = ?
        WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = ?)`,
      'shared-storyboard',
      'episode-1',
    ))
    let current = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    // Simulate provider completion order 3 -> 1 -> 2. Ordinary reconcile
    // preserves each prior placement, so line 2 gets pushed behind line 3.
    for (const [lineId, assetId, durationSeconds] of [
      ['line-3', 'speech-3', 12],
      ['line-1', 'speech-1', 10.26],
      ['line-2', 'speech-2', 12],
    ] as const) {
      bindSpeechAsset(context, lineId, assetId, { durationSeconds })
      current = context.materialization.reconcile({
        projectId: 'project-1',
        episodeId: 'episode-1',
        expectedRevisionId: current.revision.id,
      })
    }
    const arrivalOrderPositions = new Map((timelineTracks(current.document).audio[0] as unknown as {
      elements: Array<{ startTime: number; params: { dialogueLineId: string } }>
    }).elements.map((element) => [element.params.dialogueLineId, element.startTime]))
    assert.equal(arrivalOrderPositions.get('line-3'), 1_200_000)
    assert.equal(arrivalOrderPositions.get('line-2'), 3_875_000)

    const withSubtitleDocument = structuredClone(current.document)
    const withSubtitleTracks = timelineTracks(withSubtitleDocument)
    const line2Before = (withSubtitleTracks.audio[0] as unknown as {
      elements: Array<{
        id: string
        startTime: number
        duration: number
        mediaId: string
        params: { dialogueLineId: string; storySceneId: string; storyShotId: string }
      }>
    }).elements.find((element) => element.params.dialogueLineId === 'line-2')!
    // Replace the automatically materialized fallback for line-2 with this
    // deliberate provider-bound cue so this fixture continues to exercise its
    // clamp/synchronization edge rather than creating a duplicate cue set.
    withSubtitleTracks.overlay.forEach((track) => {
      track.elements = track.elements.filter((element) => (
        element.params.dialogueLineId !== 'line-2'
      ))
    })
    withSubtitleTracks.overlay.push({
      id: 'subtitle-track',
      name: 'Subtitles',
      type: 'text',
      hidden: false,
      muted: false,
      elements: [{
        id: 'line-2-cue-1',
        type: 'text',
        name: '第二句',
        startTime: line2Before.startTime + 120_000,
        duration: 120_000,
        trimStart: 0,
        trimEnd: 0,
        params: {
          content: '第二句',
          text: '第二句',
          manjuRole: 'speech-subtitle',
          dialogueLineId: 'line-2',
          storySceneId: 'scene-1',
          storyShotId: 'shot-2',
          speechAssetId: line2Before.mediaId,
          sourceAudioElementId: line2Before.id,
          subtitleCueSetId: 'line-2-cues',
          sourceCueIndex: 0,
        },
        manju: {
          subtitleCue: {
            version: 1,
            cueSetId: 'line-2-cues',
            dialogueLineId: 'line-2',
            storySceneId: 'scene-1',
            storyShotId: 'shot-2',
            speechAssetId: line2Before.mediaId,
            sourceAudioElementId: line2Before.id,
            sourceCueIndex: 0,
            sourceStartMs: 11_000,
            // A real provider cue may end a millisecond beyond the rounded
            // 24fps clip; auto-layout must clamp like export, not reject it.
            sourceEndMs: 12_001,
            sourceAudioStartTime: line2Before.startTime,
            sourceAudioTrimStart: 0,
            sourceAudioDuration: line2Before.duration,
          },
        },
      }],
    })
    const withSubtitle = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: current.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: '绑定托管字幕后等待 pipeline 自动排版',
      document: withSubtitleDocument,
    })

    const candidate = context.materialization.planAutomaticEdit({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: withSubtitle.revision.id,
    })
    assert.equal(candidate.status, 'repairable')
    assert.equal(candidate.base.revision.id, withSubtitle.revision.id)
    assert.equal(candidate.receipt?.baseRevisionId, withSubtitle.revision.id)
    assert.equal(candidate.diagnostics.managedDialogueOperations, 3)
    assert.equal(candidate.diagnostics.managedSubtitleOperations, 3)
    assert.equal(candidate.diagnostics.managedVisualTailOperations, 7)
    assert.equal(candidate.diagnostics.managedDialogueEndBefore, 5_315_000)
    assert.equal(candidate.diagnostics.managedDialogueEndAfter, 4_115_000)
    assert.equal(candidate.diagnostics.visualEndBefore, 3_960_000)
    assert.equal(candidate.diagnostics.visualEndAfter, 6_275_000)
    // Preview planning is side-effect free: it must not create a revision or
    // mutate the current immutable timeline snapshot.
    assert.equal(context.timelines.get('episode-1').revision.id, withSubtitle.revision.id)
    assert.deepEqual(context.timelines.get('episode-1').document, withSubtitle.document)

    const packed = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: withSubtitle.revision.id,
      autoLayoutManagedDialogue: true,
    })
    const packedElements = (timelineTracks(packed.document).audio[0] as unknown as {
      elements: Array<{
        startTime: number
        duration: number
        trimStart: number
        trimEnd: number
        params: { dialogueLineId: string }
      }>
    }).elements
    const byLine = new Map(packedElements.map((element) => [element.params.dialogueLineId, element]))
    assert.deepEqual(['line-1', 'line-2', 'line-3'].map((lineId) => ({
      lineId,
      startTime: byLine.get(lineId)?.startTime,
      duration: byLine.get(lineId)?.duration,
      trimStart: byLine.get(lineId)?.trimStart,
      trimEnd: byLine.get(lineId)?.trimEnd,
    })), [
      { lineId: 'line-1', startTime: 0, duration: 1_235_000, trimStart: 0, trimEnd: 0 },
      { lineId: 'line-2', startTime: 1_235_000, duration: 1_440_000, trimStart: 0, trimEnd: 0 },
      { lineId: 'line-3', startTime: 2_675_000, duration: 1_440_000, trimStart: 0, trimEnd: 0 },
    ])
    const visualEnd = timelineTracks(packed.document).overlay[0].elements.reduce(
      (maximum, element) => Math.max(maximum, element.startTime + element.duration),
      0,
    )
    assert.equal(visualEnd, 6_275_000)
    const cue = timelineTracks(packed.document).overlay
      .flatMap((track) => track.elements)
      .find((element) => element.id === 'line-2-cue-1') as unknown as {
        startTime: number
        duration: number
        manju: { subtitleCue: Record<string, unknown> }
      }
    assert.equal(cue.startTime, 2_555_000)
    assert.equal(cue.duration, 120_000)
    assert.equal(cue.manju.subtitleCue.sourceAudioStartTime, 1_235_000)
    assert.equal(cue.manju.subtitleCue.sourceAudioDuration, 1_440_000)
    const automaticEdit = packed.report.automaticEdit
    assert.equal(automaticEdit?.executor, 'OpenCut-Classic/UpdateElementsCommand')
    assert.equal(automaticEdit?.risk, 'safe')
    assert.equal(automaticEdit?.policy, 'auto-applied')
    assert.equal(automaticEdit?.planHash, candidate.receipt?.planHash)
    assert.match(automaticEdit?.planHash ?? '', /^[0-9a-f]{64}$/)
    assert.equal(automaticEdit?.operationCount, automaticEdit?.operations.length)
    assert.deepEqual(
      new Set(automaticEdit?.changedElementIds),
      new Set(automaticEdit?.operations.map((operation) => operation.elementId)),
    )
    assert.ok(automaticEdit?.operations.some((operation) => (
      operation.elementId === 'line-2-cue-1'
      && operation.reason === 'synchronize-managed-subtitle'
    )))
    const persistedAutomaticEdit = (packed.document.manjuTimeline as {
      automaticEdit?: { planHash?: string }
    }).automaticEdit
    assert.equal(persistedAutomaticEdit?.planHash, automaticEdit?.planHash)

    // Integration boundary: the immutable reflow revision must compile all
    // the way through ExportRender's semantic source-duration validation.
    const readyStoryboard = context.database.getMediaAsset('shared-storyboard')
    assert.equal(readyStoryboard?.status, 'ready')
    assert.equal(readyStoryboard?.filePath, '/fixture/shared-storyboard.png')
    assert.equal(readyStoryboard?.mimeType, 'image/png')
    const exported = new ExportRenderService(context.database, context.timelines).create({
      projectId: 'project-1',
      episodeId: 'episode-1',
      timelineRevisionId: packed.revision.id,
      resolution: '720p',
      burnSubtitles: true,
      idempotencyKey: 'real-duration-reflow-export',
    })
    const firstAudio = exported.export.timelineSnapshot.audioClips
      .find((clip) => clip.assetId === 'speech-1')
    assert.equal(firstAudio?.durationFrames, 247)
    assert.equal(exported.export.timelineSnapshot.subtitleCues
      .some((subtitle) => subtitle.id === 'line-2-cue-1'), true)
  } finally {
    context.database.close()
  }
})

test('reconcile atomically shrinks an impossible managed dialogue tail to the probed Asset duration', () => {
  const story = generatedStory()
  const context = fixture(story)
  try {
    bindSpeechAsset(context, 'line-1', 'speech-real-duration', {
      durationSeconds: 5.544,
      lineDurationSeconds: 6.25,
    })
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const corruptedDocument = structuredClone(materialized.document)
    const corruptedAudio = (timelineTracks(corruptedDocument).audio[0] as unknown as {
      elements: Array<{
        id: string
        duration: number
        trimStart: number
        trimEnd: number
        sourceDuration?: number
      }>
    }).elements.find((element) => element.id === 'dialogue-scene-1-shot-1-line-1')!
    assert.ok(corruptedAudio)
    corruptedAudio.duration = 750_000
    corruptedAudio.trimStart = 0
    corruptedAudio.trimEnd = 0
    delete corruptedAudio.sourceDuration
    const corrupted = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: '模拟旧版把语音错误拉长到镜头时长',
      document: corruptedDocument,
    })

    const repaired = context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: corrupted.revision.id,
    })
    const repairedAudio = (timelineTracks(repaired.document).audio[0] as unknown as {
      elements: Array<{
        id: string
        duration: number
        trimStart: number
        trimEnd: number
        sourceDuration?: number
      }>
    }).elements.find((element) => element.id === corruptedAudio.id)!
    const expectedDuration = Math.ceil(5.544 * 24) * (OPEN_CUT_TICKS_PER_SECOND / 24)
    assert.equal(expectedDuration, 670_000)
    assert.equal(repairedAudio.duration, expectedDuration)
    assert.equal(repairedAudio.trimStart, 0)
    assert.equal(repairedAudio.trimEnd, 0)
    assert.equal(repairedAudio.sourceDuration, expectedDuration)
    assert.equal(repaired.report.changed, true)
    assert.equal(repaired.report.preservedAudioElementIds.includes(corruptedAudio.id), true)
    assert.equal(repaired.report.speechConflicts.some((conflict) => (
      conflict.dialogueLineId === 'line-1'
      && conflict.code === 'SPEECH_DURATION_MISMATCH'
      && conflict.blocking === false
    )), true)
  } finally {
    context.database.close()
  }
})

test('explicit Agentic auto-edit preserves a contiguous but manually changed visual sequence', () => {
  const context = fixture()
  try {
    context.database.createMediaAsset({
      id: 'legacy-reflow-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'storyboard.image',
      status: 'ready',
      source: 'fixture',
      sourceRevisionId: context.sourceRevisionId,
      mimeType: 'image/png',
      checksum: 'c'.repeat(64),
      filePath: '/fixture/legacy-reflow-storyboard.png',
    })
    context.database.withSql((sql) => sql.run(
      `UPDATE shots SET storyboard_asset_id = ?
        WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = ?)`,
      'legacy-reflow-storyboard',
      'episode-1',
    ))
    bindSpeechAsset(context, 'line-1', 'legacy-reflow-speech', { durationSeconds: 2 })
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const driftedDocument = structuredClone(materialized.document)
    const visuals = timelineTracks(driftedDocument).overlay[0].elements
    visuals[0]!.duration += 120_000
    for (let index = 1; index < visuals.length; index += 1) {
      visuals[index]!.startTime += 120_000
    }
    const drifted = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
      schemaVersion: 2,
      upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
      summary: '模拟旧版连续托管镜头时长漂移',
      document: driftedDocument,
    })

    const candidate = context.materialization.planAutomaticEdit({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: drifted.revision.id,
    })
    assert.equal(candidate.receipt?.operations.some((operation) => (
      operation.elementId === visuals[0]!.id
      || operation.elementId === visuals[1]!.id
    )) ?? false, false)
    const previewVisuals = timelineTracks(candidate.document).overlay[0].elements
    assert.equal(previewVisuals[0]!.duration, visuals[0]!.duration)
    assert.equal(previewVisuals[1]!.startTime, visuals[1]!.startTime)
  } finally {
    context.database.close()
  }
})

test('pipeline auto-layout fails before persistence when another unsafe edit remains unexportable', () => {
  const context = fixture()
  try {
    context.database.createMediaAsset({
      id: 'safe-gate-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      kind: 'storyboard.image',
      status: 'ready',
      source: 'fixture',
      sourceRevisionId: context.sourceRevisionId,
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      filePath: '/fixture/safe-gate-storyboard.png',
    })
    context.database.withSql((sql) => sql.run(
      `UPDATE shots SET storyboard_asset_id = ?
        WHERE scene_id IN (SELECT id FROM scenes WHERE episode_id = ?)`,
      'safe-gate-storyboard',
      'episode-1',
    ))
    bindSpeechAsset(context, 'line-1', 'safe-gate-speech', { durationSeconds: 2 })
    const materialized = context.materialization.materialize({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: null,
    })
    const unsafeDocument = structuredClone(materialized.document)
    const tracks = timelineTracks(unsafeDocument)
    const managedDialogue = (tracks.audio[0] as unknown as {
      elements: Array<{ startTime: number }>
    }).elements[0]!
    // This managed timing is safely repairable back to the shot start.
    managedDialogue.startTime = 120_000
    // This independent free subtitle is not safe for the agent to truncate or
    // move. The shared formal-export semantic gate must reject the combination
    // before the managed timing candidate becomes a new immutable head.
    tracks.overlay.push({
      id: 'unsafe-free-subtitle-track',
      name: 'Unsafe free subtitle',
      type: 'text',
      hidden: false,
      muted: false,
      elements: [{
        id: 'unsafe-free-subtitle',
        type: 'text',
        name: 'out of bounds',
        startTime: 3_960_000,
        duration: 120_000,
        trimStart: 0,
        trimEnd: 0,
        params: { content: 'out of bounds', text: 'out of bounds' },
      }],
    })
    const unsafeHead = context.timelines.save({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: materialized.revision.id,
      schemaVersion: materialized.revision.schemaVersion,
      upstreamCommit: materialized.revision.upstreamCommit,
      summary: 'Manual repairable dialogue plus unsafe subtitle',
      document: unsafeDocument,
    })
    const revisionCount = context.timelines.listRevisions(
      unsafeHead.timelineDocument.id,
      { limit: 100 },
    ).revisions.length

    assert.throws(() => context.materialization.reconcile({
      projectId: 'project-1',
      episodeId: 'episode-1',
      expectedRevisionId: unsafeHead.revision.id,
      autoLayoutManagedDialogue: true,
    }), (error: unknown) => (
      error instanceof ExportRenderError
      && error.code === 'INVALID_TIMELINE'
      && error.message.includes('subtitle cue exceeds the visual duration')
    ))
    assert.equal(context.timelines.get('episode-1').revision.id, unsafeHead.revision.id)
    assert.equal(context.timelines.listRevisions(
      unsafeHead.timelineDocument.id,
      { limit: 100 },
    ).revisions.length, revisionCount)
  } finally {
    context.database.close()
  }
})
