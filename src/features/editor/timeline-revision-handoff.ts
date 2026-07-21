import {
  ApiError,
  type TimelineDocumentSnapshot,
  type TimelineMaterializationSnapshot,
} from '../../lib'
import type { ManagedSubtitleCueSetSnapshot } from '@manju/opencut-editor'

export type { ManagedSubtitleCueSetSnapshot } from '@manju/opencut-editor'

export interface TimelineManagedSubtitleSourceCue {
  text: string
  startMs: number
  endMs: number
}

export interface TimelineManagedSubtitleCueSetReadInput {
  dialogueLineId: string
  speechAssetId: string
}

export interface TimelineManagedSubtitleCueSetReplaceInput
  extends TimelineManagedSubtitleCueSetReadInput {
  cueSetId: string
  storySceneId: string
  storyShotId: string
  cues: TimelineManagedSubtitleSourceCue[]
}

export interface TimelinePersistenceHandle {
  projectId: string
  episodeId: string
  flush(signal?: AbortSignal): Promise<TimelineDocumentSnapshot>
  /** Reconciles authoritative Shot media and replaces the mounted OpenCut command state. */
  reconcileCurrentMedia(signal?: AbortSignal): Promise<TimelineDocumentSnapshot>
  addUploadedAudio(input: {
    assetId: string
    kind: 'bgm' | 'sfx'
    displayName: string
    durationSeconds: number
  }, signal?: AbortSignal): Promise<TimelineDocumentSnapshot>
  addSubtitle(input: {
    attachmentId: string
    text: string
    durationSeconds?: number
  }, signal?: AbortSignal): Promise<TimelineDocumentSnapshot>
  readManagedSubtitleCueSet(
    input: TimelineManagedSubtitleCueSetReadInput,
  ): ManagedSubtitleCueSetSnapshot | null
  replaceManagedSubtitleCueSet(
    input: TimelineManagedSubtitleCueSetReplaceInput,
    signal?: AbortSignal,
  ): Promise<ManagedSubtitleCueSetSnapshot>
}

export interface TimelineRevisionCoordinatorTransport {
  get(episodeId: string, signal?: AbortSignal): Promise<TimelineDocumentSnapshot>
  materialize(
    episodeId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<TimelineMaterializationSnapshot>
  reconcile(
    episodeId: string,
    projectId: string,
    etag: string,
    signal?: AbortSignal,
  ): Promise<TimelineMaterializationSnapshot>
}

/** Verifies the immutable revision/ETag boundary before a consumer opens. */
export function assertPinnedTimeline(
  snapshot: TimelineDocumentSnapshot,
  scope: { projectId: string; episodeId: string; sourceRevisionId: string | null },
): TimelineDocumentSnapshot {
  if (snapshot.timelineDocument.projectId !== scope.projectId
    || snapshot.timelineDocument.episodeId !== scope.episodeId
    || snapshot.revision.projectId !== scope.projectId
    || snapshot.revision.episodeId !== scope.episodeId) {
    throw new Error('固化时间线修订与当前制作工程不匹配')
  }
  if (snapshot.revision.id !== snapshot.timelineDocument.currentRevisionId
    || snapshot.etag !== `W/"${snapshot.revision.id}"`) {
    throw new Error('固化时间线修订的 revision/ETag 不一致')
  }
  if (scope.sourceRevisionId
    && snapshot.timelineDocument.sourceRevisionId !== scope.sourceRevisionId) {
    throw new Error('时间线尚未对账当前剧本修订，请先打开分镜时间线')
  }
  return snapshot
}

/**
 * Prepares an authoritative snapshot when no mounted editor session exists.
 * Creation/reconciliation happens once at the caller boundary; preview and
 * export remain read-only consumers of the exact returned revision.
 */
export async function preparePinnedTimeline(
  scope: { projectId: string; episodeId: string; sourceRevisionId: string | null },
  transport: TimelineRevisionCoordinatorTransport,
  signal?: AbortSignal,
): Promise<TimelineDocumentSnapshot> {
  signal?.throwIfAborted()
  let snapshot: TimelineDocumentSnapshot
  try {
    snapshot = await transport.get(scope.episodeId, signal)
  } catch (error) {
    if (!(error instanceof ApiError)
      || error.status !== 404
      || error.code !== 'TIMELINE_DOCUMENT_NOT_FOUND'
      || !scope.sourceRevisionId) throw error
    snapshot = await transport.materialize(
      scope.episodeId,
      scope.projectId,
      signal,
    )
    return assertPinnedTimeline(snapshot, scope)
  }

  // Reconcile is intentionally unconditional when a Story revision exists.
  // The server returns the current immutable revision without writing when
  // there is no change, while also upgrading old schema documents if needed.
  if (scope.sourceRevisionId) {
    snapshot = await transport.reconcile(
      scope.episodeId,
      scope.projectId,
      snapshot.etag,
      signal,
    )
  }
  return assertPinnedTimeline(snapshot, scope)
}
