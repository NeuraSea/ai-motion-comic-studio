import {
  shortVideoFillDescriptor,
  type CanonicalTimelineElement,
  type EditorTimelineElement,
} from '@manju/opencut-editor'

export interface AppliedShortVideoFillDisplay {
  fallbackAssetId: string
  sourceDurationTicks: number
  targetDurationTicks: number
  holdDurationTicks: number
  holdStartPercent: number
  holdWidthPercent: number
  appliedPlanHash: string
}

/**
 * Returns UI data only for a fill that is still active on this exact element.
 *
 * Persisted timeline metadata is untrusted at the browser boundary. The shared
 * OpenCut descriptor remains the parser of record, while this function also
 * checks element timing, trim and Story provenance so stale audit metadata is
 * never presented as a currently applied edit.
 */
export function readAppliedShortVideoFillDisplay(
  element: EditorTimelineElement,
): AppliedShortVideoFillDisplay | null {
  if (element.type !== 'video') return null

  let fill
  try {
    fill = shortVideoFillDescriptor(
      element as unknown as CanonicalTimelineElement,
      `timeline element ${element.id}`,
    )
  } catch {
    return null
  }

  if (!fill?.appliedByOpenCut || fill.appliedPlanHash === null
    || element.duration !== fill.targetDurationTicks
    || element.sourceDuration !== fill.sourceDurationTicks
    || (element.trimStart ?? 0) !== 0
    || (element.trimEnd ?? 0) !== 0
    || element.params?.storySceneId !== fill.storySceneId
    || element.params?.storyShotId !== fill.storyShotId
    || element.params?.sourceRevisionId !== fill.sourceRevisionId) return null

  const holdDurationTicks = fill.targetDurationTicks - fill.sourceDurationTicks
  return {
    fallbackAssetId: fill.fallbackAssetId,
    sourceDurationTicks: fill.sourceDurationTicks,
    targetDurationTicks: fill.targetDurationTicks,
    holdDurationTicks,
    holdStartPercent: fill.sourceDurationTicks / fill.targetDurationTicks * 100,
    holdWidthPercent: holdDurationTicks / fill.targetDurationTicks * 100,
    appliedPlanHash: fill.appliedPlanHash,
  }
}
