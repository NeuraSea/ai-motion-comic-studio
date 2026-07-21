import assert from 'node:assert/strict'
import test from 'node:test'

import type { EditorSceneTracks } from '@manju/opencut-editor'
import {
  buildTimelineAutoEditPreviewOverlay,
  readCurrentTimelineAutomaticEdit,
  TimelineAutoEditPreviewValidationError,
  withoutActiveTimelineAutoEditReceipt,
} from '../src/features/editor/timeline-automatic-edit-state'
import {
  openCutTimelineDocument,
  parseOpenCutTracks,
} from '../src/features/editor/timeline-codec'
import type { TimelineAutoEditPreview } from '../src/lib/api-types'

const COMMIT = 'cf5e79e919144200294fb9fed22a222592a0aeea'
const NOW = '2026-07-14T00:00:00.000Z'

function tracks(startTime = 0): EditorSceneTracks {
  return {
    overlay: [{
      id: 'visual-main',
      type: 'video',
      elements: [{
        id: 'image-1',
        type: 'image',
        startTime: 0,
        duration: 96_000,
        trimStart: 0,
        trimEnd: 0,
        mediaId: 'asset-image-1',
      }],
    }],
    main: { id: 'main', type: 'video', elements: [] },
    audio: [{
      id: 'dialogue-main',
      type: 'audio',
      elements: [{
        id: 'dialogue-1',
        type: 'audio',
        name: '台词',
        startTime,
        duration: 48_000,
        trimStart: 0,
        trimEnd: 0,
        mediaId: 'asset-audio-1',
      }],
    }],
  }
}

function preview(previewTracks = tracks(24_000)): TimelineAutoEditPreview {
  const baseDocument = openCutTimelineDocument(tracks())
  return {
    timeline: {
      timelineDocument: {
        id: 'timeline-1',
        projectId: 'project-1',
        episodeId: 'episode-1',
        currentRevisionId: 'revision-1',
        schemaVersion: 2,
        upstreamCommit: COMMIT,
        sourceRevisionId: 'story-1',
        createdAt: NOW,
        updatedAt: NOW,
      },
      revision: {
        id: 'revision-1',
        documentId: 'timeline-1',
        projectId: 'project-1',
        episodeId: 'episode-1',
        parentRevisionId: null,
        schemaVersion: 2,
        upstreamCommit: COMMIT,
        sourceRevisionId: 'story-1',
        summary: 'base',
        snapshot: baseDocument,
        createdAt: NOW,
      },
      document: baseDocument,
      etag: 'W/"revision-1"',
    },
    plan: {
      id: 'plan-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      documentId: 'timeline-1',
      baseRevisionId: 'revision-1',
      sourceRevisionId: 'story-1',
      goal: 'exportable',
      policy: 'safe',
      strategy: 'managed-dialogue-reflow-v1',
      executor: 'OpenCut-Classic/UpdateElementsCommand',
      upstreamCommit: COMMIT,
      schemaVersion: 2,
      planHash: 'a'.repeat(64),
      risk: 'safe',
      diagnostics: [],
      operations: [{
        kind: 'update-element-timing',
        trackId: 'dialogue-main',
        elementId: 'dialogue-1',
        reason: 'Reflow managed dialogue',
        before: { startTime: 0, duration: 48_000, trimStart: 0, trimEnd: 0 },
        after: { startTime: 24_000, duration: 48_000, trimStart: 0, trimEnd: 0 },
      }],
      changedElementIds: ['dialogue-1'],
      confirmationToken: 'confirmation-1',
      createdAt: NOW,
    },
    previewDocument: openCutTimelineDocument(previewTracks),
    diagnostics: [],
    operations: [{
      kind: 'update-element-timing',
      trackId: 'dialogue-main',
      elementId: 'dialogue-1',
      reason: 'Reflow managed dialogue',
      before: { startTime: 0, duration: 48_000, trimStart: 0, trimEnd: 0 },
      after: { startTime: 24_000, duration: 48_000, trimStart: 0, trimEnd: 0 },
    }],
    risk: 'safe',
    changedElementIds: ['dialogue-1'],
  }
}

function managedSubtitleTracks(
  audioStartTime: number,
  subtitleStartTime: number,
  provenanceAudioStartTime: number,
): EditorSceneTracks {
  const result = tracks(audioStartTime)
  result.overlay.push({
    id: 'subtitle-main',
    type: 'text',
    elements: [{
      id: 'subtitle-1',
      type: 'text',
      name: '字幕',
      startTime: subtitleStartTime,
      duration: 24_000,
      trimStart: 0,
      trimEnd: 0,
      params: {
        content: '字幕',
        text: '字幕',
        dialogueLineId: 'line-1',
        storySceneId: 'scene-1',
        storyShotId: 'shot-1',
      },
      manju: {
        subtitleCue: {
          version: 1,
          cueSetId: 'cue-set-1',
          dialogueLineId: 'line-1',
          storySceneId: 'scene-1',
          storyShotId: 'shot-1',
          speechAssetId: 'asset-audio-1',
          sourceAudioElementId: 'dialogue-1',
          sourceAudioStartTime: provenanceAudioStartTime,
          sourceAudioTrimStart: 0,
          sourceAudioDuration: 48_000,
          sourceCueIndex: 0,
          sourceStartMs: 0,
          sourceEndMs: 500,
        },
      },
    }],
  })
  return result
}

function managedSubtitlePreview(): TimelineAutoEditPreview {
  const baseTracks = managedSubtitleTracks(0, 0, 0)
  const nextTracks = managedSubtitleTracks(24_000, 24_000, 24_000)
  const candidate = preview(nextTracks)
  const operations: TimelineAutoEditPreview['operations'] = [{
    kind: 'update-element-timing',
    trackId: 'dialogue-main',
    elementId: 'dialogue-1',
    reason: 'reflow-managed-dialogue-in-story-order',
    before: { startTime: 0, duration: 48_000, trimStart: 0, trimEnd: 0 },
    after: { startTime: 24_000, duration: 48_000, trimStart: 0, trimEnd: 0 },
  }, {
    kind: 'update-element-timing',
    trackId: 'subtitle-main',
    elementId: 'subtitle-1',
    reason: 'synchronize-managed-subtitle',
    before: { startTime: 0, duration: 24_000, trimStart: 0, trimEnd: 0 },
    after: { startTime: 24_000, duration: 24_000, trimStart: 0, trimEnd: 0 },
  }]
  const baseDocument = openCutTimelineDocument(baseTracks)
  return {
    ...candidate,
    timeline: {
      ...candidate.timeline,
      document: baseDocument,
      revision: { ...candidate.timeline.revision, snapshot: baseDocument },
    },
    previewDocument: openCutTimelineDocument(nextTracks),
    operations,
    changedElementIds: ['dialogue-1', 'subtitle-1'],
    plan: {
      ...candidate.plan,
      operations,
      changedElementIds: ['dialogue-1', 'subtitle-1'],
    },
  }
}

function shortVideoFillTracks(
  duration: number,
  appliedByOpenCut: boolean,
): EditorSceneTracks {
  return {
    overlay: [{
      id: 'visual-main',
      type: 'video',
      elements: [{
        id: 'short-video-1',
        type: 'video',
        name: '短视频',
        startTime: 0,
        duration,
        trimStart: 0,
        trimEnd: 0,
        sourceDuration: 72_000,
        mediaId: 'short-video-asset',
        params: {
          storySceneId: 'scene-1',
          storyShotId: 'shot-1',
          sourceRevisionId: 'story-1',
        },
        manju: {
          shortVideoFill: {
            version: 1,
            strategy: 'same-shot-locked-image-hold-v1',
            fallbackAssetId: 'storyboard-asset',
            storySceneId: 'scene-1',
            storyShotId: 'shot-1',
            sourceRevisionId: 'story-1',
            sourceDurationTicks: 72_000,
            targetDurationTicks: 120_000,
            appliedByOpenCut,
            appliedPlanHash: appliedByOpenCut ? 'f'.repeat(64) : null,
          },
        },
      }],
    }],
    main: { id: 'main', type: 'video', elements: [] },
    audio: [],
  }
}

function shortVideoFillPreview(): TimelineAutoEditPreview {
  const baseDocument = openCutTimelineDocument(shortVideoFillTracks(72_000, false))
  const plannedDocument = openCutTimelineDocument(shortVideoFillTracks(120_000, true))
  const candidate = preview()
  const operations: TimelineAutoEditPreview['operations'] = [{
    kind: 'update-element-timing',
    trackId: 'visual-main',
    elementId: 'short-video-1',
    reason: 'fill-short-managed-video-with-same-shot-image',
    before: { startTime: 0, duration: 72_000, trimStart: 0, trimEnd: 0 },
    after: { startTime: 0, duration: 120_000, trimStart: 0, trimEnd: 0 },
  }]
  return {
    ...candidate,
    timeline: {
      ...candidate.timeline,
      document: baseDocument,
      revision: { ...candidate.timeline.revision, snapshot: baseDocument },
    },
    previewDocument: plannedDocument,
    operations,
    changedElementIds: ['short-video-1'],
    plan: { ...candidate.plan, operations, changedElementIds: ['short-video-1'] },
  }
}

test('auto-edit preview overlay projects the server plan without mutating live OpenCut tracks', () => {
  const baseDocument = openCutTimelineDocument(tracks())
  const live = parseOpenCutTracks(baseDocument)
  assert.ok(live)
  const before = structuredClone(live)

  const overlay = buildTimelineAutoEditPreviewOverlay(live, preview())
  assert.deepEqual(overlay.timingByElement.get('dialogue-main\u0000dialogue-1'), {
    startTime: 24_000,
    duration: 48_000,
    trimStart: 0,
    trimEnd: 0,
  })
  assert.deepEqual([...overlay.changedElementIds], ['dialogue-1'])
  assert.deepEqual(live, before)
})

test('auto-edit preview overlay rejects undeclared media/content changes', () => {
  const base = parseOpenCutTracks(openCutTimelineDocument(tracks()))
  assert.ok(base)
  const maliciousTracks = tracks(24_000)
  maliciousTracks.audio[0]!.elements[0]!.mediaId = 'different-audio'

  assert.throws(
    () => buildTimelineAutoEditPreviewOverlay(base, preview(maliciousTracks)),
    TimelineAutoEditPreviewValidationError,
  )
})

test('auto-edit preview overlay rejects a stale live timing state', () => {
  const staleLive = parseOpenCutTracks(openCutTimelineDocument(tracks(12_000)))
  assert.ok(staleLive)
  assert.throws(
    () => buildTimelineAutoEditPreviewOverlay(staleLive, preview()),
    /current OpenCut|currently|changed|当前时间线/,
  )
})

test('auto-edit preview accepts only the declared managed subtitle provenance refresh', () => {
  const candidate = managedSubtitlePreview()
  const live = parseOpenCutTracks(candidate.timeline.document)
  assert.ok(live)

  const overlay = buildTimelineAutoEditPreviewOverlay(live, candidate)
  assert.equal(overlay.timingByElement.size, 2)
  assert.deepEqual([...overlay.changedElementIds], ['dialogue-1', 'subtitle-1'])
})

test('auto-edit preview accepts only the declared short-video audit transition', () => {
  const candidate = shortVideoFillPreview()
  const live = parseOpenCutTracks(candidate.timeline.document)
  assert.ok(live)
  const overlay = buildTimelineAutoEditPreviewOverlay(live, candidate)
  assert.deepEqual([...overlay.changedElementIds], ['short-video-1'])

  const forged = shortVideoFillPreview()
  const forgedTracks = parseOpenCutTracks(forged.previewDocument)
  assert.ok(forgedTracks)
  const forgedFill = forgedTracks.overlay[0]?.elements[0]?.manju?.shortVideoFill
  assert.ok(forgedFill && typeof forgedFill === 'object' && !Array.isArray(forgedFill))
  forgedFill.fallbackAssetId = 'other-shot-storyboard'
  forged.previewDocument = openCutTimelineDocument(forgedTracks)
  assert.throws(
    () => buildTimelineAutoEditPreviewOverlay(live, forged),
    TimelineAutoEditPreviewValidationError,
  )
})

test('auto-edit preview rejects forged or unrelated managed subtitle provenance changes', () => {
  const inconsistent = managedSubtitlePreview()
  const inconsistentTracks = parseOpenCutTracks(inconsistent.previewDocument)
  assert.ok(inconsistentTracks)
  const inconsistentCue = inconsistentTracks.overlay[1]?.elements[0]?.manju?.subtitleCue
  assert.ok(inconsistentCue && typeof inconsistentCue === 'object' && !Array.isArray(inconsistentCue))
  inconsistentCue.sourceAudioStartTime = 12_000
  inconsistent.previewDocument = openCutTimelineDocument(inconsistentTracks)

  const changedCue = managedSubtitlePreview()
  const changedCueTracks = parseOpenCutTracks(changedCue.previewDocument)
  assert.ok(changedCueTracks)
  const changedCueMetadata = changedCueTracks.overlay[1]?.elements[0]?.manju?.subtitleCue
  assert.ok(changedCueMetadata && typeof changedCueMetadata === 'object' && !Array.isArray(changedCueMetadata))
  changedCueMetadata.sourceStartMs = 100
  changedCue.previewDocument = openCutTimelineDocument(changedCueTracks)

  const live = parseOpenCutTracks(managedSubtitlePreview().timeline.document)
  assert.ok(live)
  assert.throws(
    () => buildTimelineAutoEditPreviewOverlay(live, inconsistent),
    TimelineAutoEditPreviewValidationError,
  )
  assert.throws(
    () => buildTimelineAutoEditPreviewOverlay(live, changedCue),
    TimelineAutoEditPreviewValidationError,
  )
})

test('manual timeline revisions remove only the active auto-edit receipt', () => {
  const receipt = {
    version: 1,
    strategy: 'managed-dialogue-reflow-v1',
    executor: 'OpenCut-Classic/UpdateElementsCommand',
    policy: 'auto-applied',
    risk: 'safe',
    baseRevisionId: 'revision-before-application',
    planHash: 'a'.repeat(64),
    operationCount: 1,
    changedElementIds: ['dialogue-1'],
    applicationId: 'application-1',
    planId: 'plan-1',
  }
  const original = openCutTimelineDocument(tracks(), {
    manjuTimeline: {
      manifestVersion: 2,
      automaticEdit: receipt,
    },
    extension: { retained: true },
  })
  const manual = withoutActiveTimelineAutoEditReceipt(original)

  assert.equal(
    readCurrentTimelineAutomaticEdit(original, 'revision-before-application')?.applicationId,
    'application-1',
  )
  assert.equal(readCurrentTimelineAutomaticEdit(manual, 'revision-application'), null)
  assert.equal(
    readCurrentTimelineAutomaticEdit(original, 'revision-application'),
    null,
    'a copied receipt must not expose undo after a later manual revision',
  )
  assert.equal(
    Object.hasOwn(manual.manjuTimeline as Record<string, unknown>, 'automaticEdit'),
    false,
  )
  assert.equal((manual.manjuTimeline as Record<string, unknown>).manifestVersion, 2)
  assert.deepEqual(manual.extension, { retained: true })
  assert.equal(
    Object.hasOwn(original.manjuTimeline as Record<string, unknown>, 'automaticEdit'),
    true,
  )
})
