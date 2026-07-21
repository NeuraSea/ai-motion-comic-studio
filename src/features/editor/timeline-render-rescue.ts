import { RenderSemanticPlanError } from '@manju/opencut-editor'

import type { TimelineDocumentSnapshot } from '../../lib'

export type TimelineRenderFailureKind =
  | 'unsupported'
  | 'invalid'
  | 'media'
  | 'unknown'

export interface TimelineRenderFailure {
  kind: TimelineRenderFailureKind
  code: string
  path: string | null
  title: string
  message: string
  retryable: boolean
  rescueRecommended: boolean
}

export interface TimelineRenderRescueEnvelope {
  version: 1
  kind: 'manju.timeline-render-compatibility-rescue'
  capturedAt: string
  failure: TimelineRenderFailure
  scope: {
    projectId: string
    episodeId: string
    sourceRevisionId: string | null
    timelineDocumentId: string
    timelineRevisionId: string
    timelineEtag: string
    schemaVersion: number
    upstreamCommit: string
  }
  /** Exact immutable head handed to preview; unknown OpenCut fields remain intact. */
  document: Record<string, unknown>
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function classifyTimelineRenderFailure(cause: unknown): TimelineRenderFailure {
  if (cause instanceof RenderSemanticPlanError) {
    const unsupported = cause.code === 'UNSUPPORTED_TIMELINE'
    return {
      kind: unsupported ? 'unsupported' : 'invalid',
      code: cause.code,
      path: cause.path,
      title: unsupported ? '当前时间线超出已审核预览子集' : '当前时间线未通过严格渲染校验',
      message: cause.message,
      retryable: false,
      rescueRecommended: true,
    }
  }

  const candidate = cause && typeof cause === 'object'
    ? cause as { code?: unknown; message?: unknown }
    : null
  const code = typeof candidate?.code === 'string' ? candidate.code : 'PREVIEW_PREPARE_FAILED'
  const message = cause instanceof Error
    ? cause.message
    : typeof candidate?.message === 'string'
      ? candidate.message
      : '无法准备时间线预览'
  const media = code === 'MEDIA_UNRESOLVED'
  return {
    kind: media ? 'media' : 'unknown',
    code,
    path: null,
    title: media ? '时间线媒体未通过安全解析' : '预览准备失败',
    message,
    retryable: !media,
    rescueRecommended: media,
  }
}

export function buildTimelineRenderRescueEnvelope(input: {
  snapshot: TimelineDocumentSnapshot
  failure: TimelineRenderFailure
  capturedAt?: string
}): TimelineRenderRescueEnvelope {
  const { snapshot } = input
  return {
    version: 1,
    kind: 'manju.timeline-render-compatibility-rescue',
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    failure: clone(input.failure),
    scope: {
      projectId: snapshot.timelineDocument.projectId,
      episodeId: snapshot.timelineDocument.episodeId,
      sourceRevisionId: snapshot.revision.sourceRevisionId,
      timelineDocumentId: snapshot.timelineDocument.id,
      timelineRevisionId: snapshot.revision.id,
      timelineEtag: snapshot.etag,
      schemaVersion: snapshot.revision.schemaVersion,
      upstreamCommit: snapshot.revision.upstreamCommit,
    },
    document: clone(snapshot.document),
  }
}

function safeFilePart(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized.slice(0, 80) || 'timeline'
}

export function timelineRenderRescueFilename(snapshot: TimelineDocumentSnapshot): string {
  return [
    'manju',
    safeFilePart(snapshot.timelineDocument.episodeId),
    safeFilePart(snapshot.revision.id),
    'render-rescue.json',
  ].join('-')
}

export function serializeTimelineRenderRescue(envelope: TimelineRenderRescueEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}
