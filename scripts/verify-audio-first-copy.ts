import { isDeepStrictEqual } from 'node:util'

import {
  parseCanonicalTimelineDocument,
  type CanonicalImageElement,
  type CanonicalTextElement,
  type CanonicalTimelineElement,
  type CanonicalUploadAudioElement,
  type CanonicalVideoElement,
} from '../apps/opencut-editor/src/canonical-timeline-codec.js'
import { shortVideoFillDescriptor } from '../apps/opencut-editor/src/render-semantic-plan.js'
import { initializeDatabase, type ManjuDatabase } from '../server/database.js'
import { validateExportRenderSemantics } from '../server/export-render.js'
import {
  resolveShotVideoDuration,
  SHOT_VIDEO_DURATION_FRAME_RATE,
  type ShotVideoDurationDecision,
  type ShotVideoSpeechDurationBinding,
} from '../server/shot-video-duration.js'
import { StoryRepository } from '../server/story-repository.js'
import type { StoryDocument, StoryShot } from '../server/story-schema.js'
import { TimelineMaterializationService } from '../server/timeline-materialization.js'
import {
  SQLiteTimelineDocumentRepository,
  TimelineDocumentService,
  type TimelineDocumentSnapshot,
} from '../server/timeline-documents.js'
import {
  guardIsolatedDatabaseCopy,
  requireSpokenShotCount,
  revalidateGuardedDatabaseCopy,
} from './verify-audio-first-copy-safety.js'

const databaseArgument = process.argv[2]
if (!databaseArgument) throw new Error('usage: tsx scripts/verify-audio-first-copy.ts <copied-db>')

// Both checks happen before initializeDatabase, whose WAL pragma and migrations
// may write. The canonical real path is what SQLite receives.
const guardedCopy = guardIsolatedDatabaseCopy(databaseArgument)
revalidateGuardedDatabaseCopy(guardedCopy)
const databasePath = guardedCopy.realPath

interface EpisodeRow {
  id: string
  project_id: string
  source_revision_id: string
}

interface ShotRow {
  scene_id: string
  shot_id: string
  database_shot_id: string
  storyboard_asset_id: string | null
}

interface ExpectedShot {
  sceneId: string
  shotId: string
  databaseShotId: string
  storyboardAssetId: string | null
  storyOrder: number
  spoken: boolean
  expectedFrames: number
  durationDecision: ShotVideoDurationDecision
  lines: ShotVideoSpeechDurationBinding[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shotKey(sceneId: string, shotId: string): string {
  return JSON.stringify([sceneId, shotId])
}

function requireEpisode(database: ManjuDatabase): EpisodeRow {
  const episode = database.withSql((sql) => sql.get(`
    SELECT id, project_id, source_revision_id
      FROM episodes
     ORDER BY updated_at DESC
     LIMIT 1
  `))
  if (!episode
    || typeof episode.id !== 'string'
    || typeof episode.project_id !== 'string'
    || typeof episode.source_revision_id !== 'string') {
    throw new Error('copied database has no current Episode/Story revision')
  }
  return episode as unknown as EpisodeRow
}

function relationalShotRows(database: ManjuDatabase, episodeId: string): ShotRow[] {
  const rows = database.withSql((sql) => sql.all(`
    SELECT
      COALESCE(NULLIF(json_extract(scenes.metadata_json, '$.storyId'), ''), scenes.id)
        AS scene_id,
      COALESCE(NULLIF(json_extract(shots.metadata_json, '$.storyId'), ''), shots.id)
        AS shot_id,
      shots.id AS database_shot_id,
      shots.storyboard_asset_id
    FROM shots
    JOIN scenes ON scenes.id = shots.scene_id
    WHERE scenes.episode_id = ?
    ORDER BY scenes.sequence, shots.sequence
  `, episodeId))
  return rows.map((row): ShotRow => {
    if (typeof row.scene_id !== 'string'
      || typeof row.shot_id !== 'string'
      || typeof row.database_shot_id !== 'string'
      || (row.storyboard_asset_id !== null && typeof row.storyboard_asset_id !== 'string')) {
      throw new Error('copied database contains an invalid relational Story shot')
    }
    return row as unknown as ShotRow
  })
}

/**
 * Resolve every Story shot through the same fail-closed speech authority used
 * by Seedance preflight and OpenCut materialization. It validates the bound
 * Asset's episode/project scope, source revision, version, checksum, readiness,
 * MIME type and measured duration before this verifier trusts any timing.
 */
function expectedShots(
  database: ManjuDatabase,
  story: StoryDocument,
  scope: { projectId: string; episodeId: string; sourceRevisionId: string },
): ExpectedShot[] {
  requireSpokenShotCount(story.scenes.flatMap((scene) => scene.shots))

  const rowsByKey = new Map<string, ShotRow>()
  for (const row of relationalShotRows(database, scope.episodeId)) {
    const key = shotKey(row.scene_id, row.shot_id)
    if (rowsByKey.has(key)) throw new Error(`duplicate relational Story shot ${key}`)
    rowsByKey.set(key, row)
  }

  let storyOrder = 0
  return story.scenes.flatMap((scene) => scene.shots.map((shot: StoryShot): ExpectedShot => {
    const currentOrder = storyOrder
    storyOrder += 1
    const row = rowsByKey.get(shotKey(scene.id, shot.id))
    if (!row) throw new Error(`Story shot ${scene.id}/${shot.id} has no relational row`)
    const resolution = resolveShotVideoDuration(database, {
      databaseShotId: row.database_shot_id,
      publicShotId: shot.id,
      projectId: scope.projectId,
      episodeId: scope.episodeId,
      sourceRevisionId: scope.sourceRevisionId,
      durationSeconds: shot.durationSeconds,
    })
    if (resolution.status !== 'ready') {
      throw new Error(
        `shot ${shot.id} has no safe authoritative duration: ${JSON.stringify(resolution)}`,
      )
    }
    const spoken = shot.dialogueLines.length > 0
    if (spoken && resolution.decision.source !== 'speech_assets') {
      throw new Error(`spoken shot ${shot.id} is not driven by current speech Assets`)
    }
    if (!spoken && resolution.decision.speechBindings.length !== 0) {
      throw new Error(`silent shot ${shot.id} unexpectedly has speech bindings`)
    }
    const expectedLineIds = shot.dialogueLines.map((line) => line.id)
    const bindingLineIds = resolution.decision.speechBindings.map((binding) => (
      binding.dialogueLineId
    ))
    if (!isDeepStrictEqual(bindingLineIds, expectedLineIds)) {
      throw new Error(
        `shot ${shot.id} speech bindings do not exactly match current Story lines`,
      )
    }
    const expectedFrames = resolution.decision.timelineDurationSeconds
      * SHOT_VIDEO_DURATION_FRAME_RATE
    if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1) {
      throw new Error(`shot ${shot.id} has a non-frame-aligned duration decision`)
    }
    return {
      sceneId: scene.id,
      shotId: shot.id,
      databaseShotId: row.database_shot_id,
      storyboardAssetId: row.storyboard_asset_id,
      storyOrder: currentOrder,
      spoken,
      expectedFrames,
      durationDecision: resolution.decision,
      lines: resolution.decision.speechBindings,
    }
  }))
}

function timelineRevisionCount(database: ManjuDatabase, documentId: string): number {
  const row = database.withSql((sql) => sql.get(`
    SELECT COUNT(*) AS count
      FROM timeline_document_revisions
     WHERE document_id = ?
  `, documentId))
  if (!row || typeof row.count !== 'number' || !Number.isSafeInteger(row.count)) {
    throw new Error('could not count immutable timeline revisions')
  }
  return row.count
}

function requireConsecutiveStableReconciles(
  database: ManjuDatabase,
  timelines: TimelineDocumentService,
  materialization: TimelineMaterializationService,
  scope: { projectId: string; episodeId: string },
  stabilized: TimelineDocumentSnapshot,
): { snapshot: TimelineDocumentSnapshot; passes: Array<Record<string, unknown>> } {
  const stableHead = stabilized.revision.id
  const stableDocumentId = stabilized.timelineDocument.id
  const stableRevisionCount = timelineRevisionCount(database, stableDocumentId)
  let snapshot = stabilized
  const passes: Array<Record<string, unknown>> = []

  // Two consecutive full reconciles, not merely two reads, must be no-ops.
  for (let index = 0; index < 2; index += 1) {
    const result = materialization.reconcile({
      ...scope,
      expectedRevisionId: snapshot.revision.id,
      autoLayoutManagedDialogue: true,
      summary: `isolated audio-first idempotency pass ${index + 1}`,
    })
    const persistedHead = timelines.get(scope.episodeId)
    const persistedCount = timelineRevisionCount(database, stableDocumentId)
    if (result.report.changed !== false
      || result.revision.id !== stableHead
      || persistedHead.revision.id !== stableHead
      || persistedCount !== stableRevisionCount) {
      throw new Error(
        `reconcile idempotency pass ${index + 1} changed head/revision count: ${JSON.stringify({
          changed: result.report.changed,
          returnedHead: result.revision.id,
          persistedHead: persistedHead.revision.id,
          stableHead,
          persistedCount,
          stableRevisionCount,
        })}`,
      )
    }
    snapshot = result
    passes.push({
      pass: index + 1,
      changed: result.report.changed,
      revisionId: result.revision.id,
      revisionCount: persistedCount,
    })
  }
  return { snapshot, passes }
}

function requireTimingDecision(
  document: Record<string, unknown>,
  expected: ExpectedShot,
  sourceRevisionId: string,
): void {
  const integration = document.manjuTimeline
  if (!isObject(integration)) throw new Error('timeline has no Manju integration manifest')
  const timing = integration.audioDrivenTiming
  if (!isObject(timing)
    || timing.policy !== 'speech-assets-first-v1'
    || timing.sourceRevisionId !== sourceRevisionId
    || !Array.isArray(timing.shots)) {
    throw new Error('timeline has no current audio-driven timing manifest')
  }
  const entries = timing.shots.filter((entry) => isObject(entry)
    && entry.sceneId === expected.sceneId
    && entry.shotId === expected.shotId)
  if (entries.length !== 1) {
    throw new Error(`shot ${expected.shotId} has ${entries.length} timing manifest entries`)
  }
  const entry = entries[0]!
  if (entry.timelineDurationSeconds !== expected.durationDecision.timelineDurationSeconds
    || !isDeepStrictEqual(entry.durationDecision, expected.durationDecision)) {
    throw new Error(
      `shot ${expected.shotId} timing manifest does not retain authoritative speech identity`,
    )
  }
}

const database = initializeDatabase({ databasePath, legacyStatePath: false })
try {
  const episode = requireEpisode(database)
  const episodeId = episode.id
  const projectId = episode.project_id
  const sourceRevisionId = episode.source_revision_id
  const stories = new StoryRepository(database)
  const story = stories.getStory(episodeId)
  if (!story) throw new Error('copied database has no Story')

  // Resolve and validate all speech before the verifier performs its first
  // isolated reconciliation write. A zero-spoken-shot fixture fails explicitly.
  const expectations = expectedShots(database, story, {
    projectId,
    episodeId,
    sourceRevisionId,
  })
  const spokenShotCount = expectations.filter((shot) => shot.spoken).length
  const dialogueLineCount = expectations.reduce((total, shot) => total + shot.lines.length, 0)

  const timelines = new TimelineDocumentService(
    new SQLiteTimelineDocumentRepository(database),
  )
  const materialization = new TimelineMaterializationService(database, stories, timelines)
  const before = timelines.get(episodeId)
  const firstReconcile = materialization.reconcile({
    projectId,
    episodeId,
    expectedRevisionId: before.revision.id,
    autoLayoutManagedDialogue: true,
    summary: 'isolated audio-first acceptance; never persisted to production',
  })
  const stable = requireConsecutiveStableReconciles(
    database,
    timelines,
    materialization,
    { projectId, episodeId },
    firstReconcile,
  )
  const reconciled = stable.snapshot
  const document = parseCanonicalTimelineDocument(reconciled.document)
  const ticksPerFrame = document.ticksPerSecond / SHOT_VIDEO_DURATION_FRAME_RATE

  for (const expected of expectations) {
    requireTimingDecision(
      reconciled.document as Record<string, unknown>,
      expected,
      sourceRevisionId,
    )
  }

  const visualElements = [...document.tracks.overlay, document.tracks.main]
    .filter((track) => track.hidden !== true)
    .flatMap((track) => track.elements)
    .filter((element): element is CanonicalImageElement | CanonicalVideoElement => (
      element.hidden !== true && (element.type === 'image' || element.type === 'video')
    ))
  const audioElements = document.tracks.audio
    .filter((track) => track.muted !== true)
    .flatMap((track) => track.elements)
    .filter((element): element is CanonicalUploadAudioElement => (
      element.hidden !== true && element.type === 'audio' && element.sourceType === 'upload'
    ))
  const subtitleElements = document.tracks.overlay
    .filter((track) => track.hidden !== true && track.type === 'text')
    .flatMap((track) => track.elements)
    .filter((element: CanonicalTimelineElement): element is CanonicalTextElement => (
      element.hidden !== true && element.type === 'text'
        && element.params?.manjuRole === 'speech-subtitle'
    ))

  const shotReport = expectations.map((expected) => {
    const visuals = visualElements.filter((element) => (
      element.params?.storySceneId === expected.sceneId
      && element.params?.storyShotId === expected.shotId
    ))
    if (visuals.length !== 1) {
      throw new Error(`shot ${expected.shotId} has ${visuals.length} managed visual elements`)
    }
    const visual = visuals[0]!
    const visualFrames = visual.duration / ticksPerFrame
    if (visualFrames !== expected.expectedFrames) {
      throw new Error(
        `shot ${expected.shotId} visual=${visualFrames}f, authority=${expected.expectedFrames}f`,
      )
    }
    const lineAudio = expected.lines.map((line) => {
      const candidates = audioElements.filter((element) => (
        element.params?.dialogueLineId === line.dialogueLineId
        && element.mediaId === line.assetId
      ))
      if (candidates.length !== 1) {
        throw new Error(`line ${line.dialogueLineId} has ${candidates.length} exact speech clips`)
      }
      const audio = candidates[0]!
      const audioEnd = audio.startTime + audio.duration
      const visualEnd = visual.startTime + visual.duration
      if (audio.startTime < visual.startTime || audioEnd > visualEnd) {
        throw new Error(`line ${line.dialogueLineId} crosses shot ${expected.shotId}`)
      }
      if (audio.duration / ticksPerFrame !== line.durationFrames) {
        throw new Error(`line ${line.dialogueLineId} does not retain measured frame envelope`)
      }
      const cues = subtitleElements.filter((element) => {
        const provenance = element.manju?.subtitleCue
        return provenance && typeof provenance === 'object'
          && !Array.isArray(provenance)
          && provenance.dialogueLineId === line.dialogueLineId
          && provenance.speechAssetId === line.assetId
          && provenance.sourceAudioElementId === audio.id
      })
      if (cues.length < 1) {
        throw new Error(`line ${line.dialogueLineId} has no materialized subtitle cue`)
      }
      if (cues.some((cue) => cue.startTime < audio.startTime
        || cue.startTime + cue.duration > audioEnd)) {
        throw new Error(`line ${line.dialogueLineId} subtitle escapes its exact speech clip`)
      }
      return {
        lineId: line.dialogueLineId,
        speechAssetId: line.assetId,
        speechAssetVersion: line.version,
        speechAssetChecksum: line.checksum,
        startFrame: audio.startTime / ticksPerFrame,
        durationFrames: audio.duration / ticksPerFrame,
        subtitleCueCount: cues.length,
      }
    })
    const fill = shortVideoFillDescriptor(visual, `shot ${expected.shotId}`)
    if (fill && (fill.storySceneId !== expected.sceneId
      || fill.storyShotId !== expected.shotId
      || fill.fallbackAssetId !== expected.storyboardAssetId
      || fill.appliedByOpenCut !== true)) {
      throw new Error(`shot ${expected.shotId} uses a non-same-shot or unaudited visual fill`)
    }
    return {
      shotId: expected.shotId,
      storyOrder: expected.storyOrder,
      spoken: expected.spoken,
      startFrame: visual.startTime / ticksPerFrame,
      durationFrames: visualFrames,
      authorityFrames: expected.expectedFrames,
      durationSource: expected.durationDecision.source,
      visualType: visual.type,
      shortVideoFillAssetId: fill?.fallbackAssetId ?? null,
      lineAudio,
    }
  })
  const ordered = [...shotReport].sort((left, right) => left.storyOrder - right.storyOrder)
  if (ordered[0]?.startFrame !== 0) throw new Error('Story visual timeline does not start at frame 0')
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!
    const current = ordered[index]!
    if (previous.startFrame + previous.durationFrames !== current.startFrame) {
      throw new Error(`visual gap/overlap between ${previous.shotId} and ${current.shotId}`)
    }
  }

  const semanticPlan = validateExportRenderSemantics(database, {
    projectId,
    episodeId,
    timelineDocumentId: reconciled.timelineDocument.id,
    timelineRevisionId: reconciled.revision.id,
    storyRevisionId: sourceRevisionId,
    document: reconciled.document,
  })
  const expectedTotalFrames = ordered.reduce((sum, shot) => sum + shot.durationFrames, 0)
  if (semanticPlan.totalFrames !== expectedTotalFrames) {
    throw new Error(`semantic total=${semanticPlan.totalFrames}f, expected=${expectedTotalFrames}f`)
  }
  if (semanticPlan.subtitleCues.length < dialogueLineCount) {
    throw new Error(
      `formal semantic plan has ${semanticPlan.subtitleCues.length}/${dialogueLineCount} subtitle cues`,
    )
  }

  console.log(JSON.stringify({
    databasePath,
    projectId,
    episodeId,
    sourceRevisionId,
    beforeTimelineRevisionId: before.revision.id,
    reconciledTimelineRevisionId: reconciled.revision.id,
    initialReconcileChanged: firstReconcile.report.changed,
    stableReconcilePasses: stable.passes,
    automaticEdit: firstReconcile.report.automaticEdit && {
      executor: firstReconcile.report.automaticEdit.executor,
      operationCount: firstReconcile.report.automaticEdit.operationCount,
      planHash: firstReconcile.report.automaticEdit.planHash,
    },
    storyShotCount: expectations.length,
    spokenShotCount,
    dialogueLineCount,
    speechBindingAuthority: [
      'projectId',
      'episodeId',
      'sourceRevisionId',
      'status=ready',
      'mimeType=audio/mpeg|audio/wav',
      'version',
      'checksum',
      'measuredDuration',
    ],
    totalFrames: semanticPlan.totalFrames,
    durationSeconds: semanticPlan.totalFrames / SHOT_VIDEO_DURATION_FRAME_RATE,
    semanticVisualClipCount: semanticPlan.visualClips.length,
    semanticAudioClipCount: semanticPlan.audioClips.length,
    semanticSubtitleCueCount: semanticPlan.subtitleCues.length,
    shots: ordered,
  }, null, 2))
} finally {
  database.close()
}
