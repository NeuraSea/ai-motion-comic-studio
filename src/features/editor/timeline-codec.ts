import {
  canonicalTimelineDocumentFromTracks,
  parseCanonicalTimelineDocument,
  type EditorSceneTracks,
} from '@manju/opencut-editor'
import type {
  TimelineDocumentRevision,
  TimelineDocumentSnapshot,
} from '../../lib/api-types'

export interface OpenCutRevisionCompatibility {
  compatible: boolean
  canonical: boolean
  reasons: string[]
}

export interface OpenCutRevisionExpectedScope {
  projectId: string
  episodeId: string
  schemaVersion: number
  upstreamCommit: string
  sourceRevisionId: string | null
}

export interface OpenCutSnapshotCompatibilityOptions {
  /**
   * A persisted timeline may legitimately trail the current Story revision
   * immediately before reconcile. In that one boundary we still require the
   * document record and immutable revision to agree with each other, but do
   * not require their shared source revision to equal the new Story head yet.
   */
  allowStaleSourceRevision?: boolean
}

/**
 * Client boundary for persisted timeline documents. Validation and legacy
 * migration intentionally live in the shared OpenCut codec, not in React.
 */
export function parseOpenCutTracks(
  document: Record<string, unknown>,
): EditorSceneTracks | null {
  try {
    return structuredClone(
      parseCanonicalTimelineDocument(document).tracks,
    ) as unknown as EditorSceneTracks
  } catch {
    return null
  }
}

export function openCutTimelineDocument(
  tracks: EditorSceneTracks,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  return canonicalTimelineDocumentFromTracks(
    structuredClone(tracks),
    base,
  ) as unknown as Record<string, unknown>
}

/**
 * Restore is a trust boundary, not merely a history-row selection. A revision
 * is eligible only when both its immutable metadata and its raw snapshot match
 * the currently loaded authoritative timeline scope, and the snapshot can be
 * parsed by the pinned OpenCut codec.
 */
export function inspectOpenCutRevisionCompatibility(
  revision: TimelineDocumentRevision,
  authoritative: TimelineDocumentSnapshot,
  expected: OpenCutRevisionExpectedScope = authoritative.timelineDocument,
): OpenCutRevisionCompatibility {
  const reasons: string[] = []
  const head = authoritative.timelineDocument
  if (revision.documentId !== head.id
    || revision.projectId !== expected.projectId
    || revision.episodeId !== expected.episodeId) {
    reasons.push('项目、分集或时间线文档作用域不一致')
  }
  if (revision.schemaVersion !== expected.schemaVersion) {
    reasons.push('canonical schema 版本不一致')
  }
  if (revision.upstreamCommit !== expected.upstreamCommit) {
    reasons.push('pinned OpenCut 上游 commit 不一致')
  }
  if (revision.sourceRevisionId !== expected.sourceRevisionId) {
    reasons.push('Story 源修订不一致')
  }
  const canonical = parseOpenCutTracks(revision.snapshot) !== null
  if (!canonical) reasons.push('快照未通过 pinned OpenCut canonical 校验')
  return {
    compatible: reasons.length === 0,
    canonical,
    reasons,
  }
}

/**
 * Validates an authoritative current head before it can be reconciled or
 * exposed to the editor. Unlike a history row, a current-head response has two
 * metadata envelopes plus an ETag and a duplicated canonical document. Every
 * copy must agree; parsing only `snapshot.document` is not sufficient.
 */
export function inspectOpenCutSnapshotCompatibility(
  snapshot: TimelineDocumentSnapshot,
  expected: OpenCutRevisionExpectedScope,
  options: OpenCutSnapshotCompatibilityOptions = {},
): OpenCutRevisionCompatibility {
  const head = snapshot.timelineDocument
  const revisionExpected = options.allowStaleSourceRevision
    ? { ...expected, sourceRevisionId: head.sourceRevisionId }
    : expected
  const revisionCompatibility = inspectOpenCutRevisionCompatibility(
    snapshot.revision,
    snapshot,
    revisionExpected,
  )
  const reasons = [...revisionCompatibility.reasons]
  const appendReason = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  if (head.projectId !== expected.projectId || head.episodeId !== expected.episodeId) {
    appendReason('项目、分集或时间线文档作用域不一致')
  }
  if (head.schemaVersion !== expected.schemaVersion) {
    appendReason('canonical schema 版本不一致')
  }
  if (head.upstreamCommit !== expected.upstreamCommit) {
    appendReason('pinned OpenCut 上游 commit 不一致')
  }
  if (!options.allowStaleSourceRevision
    && head.sourceRevisionId !== expected.sourceRevisionId) {
    appendReason('Story 源修订不一致')
  }
  if (head.currentRevisionId !== snapshot.revision.id
    || snapshot.etag !== `W/"${snapshot.revision.id}"`) {
    appendReason('authoritative head 修订游标或 ETag 不一致')
  }
  if (JSON.stringify(snapshot.revision.snapshot) !== JSON.stringify(snapshot.document)) {
    appendReason('authoritative document 与不可变修订快照不一致')
  }
  const documentCanonical = parseOpenCutTracks(snapshot.document) !== null
  if (!documentCanonical) appendReason('快照未通过 pinned OpenCut canonical 校验')

  return {
    compatible: reasons.length === 0,
    canonical: revisionCompatibility.canonical && documentCanonical,
    reasons,
  }
}

export function parseOpenCutFrameRate(document: Record<string, unknown>): {
  numerator: number
  denominator: number
} {
  try {
    return { ...parseCanonicalTimelineDocument(document).frameRate }
  } catch {
    return { numerator: 24, denominator: 1 }
  }
}
