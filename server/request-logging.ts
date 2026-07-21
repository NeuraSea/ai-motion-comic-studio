import { randomUUID } from 'node:crypto'

import type { NextFunction, Request, RequestHandler, Response } from 'express'

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/
const MAX_ROUTE_LENGTH = 240

export interface SafeRequestLogEntry {
  event: 'http.request'
  requestId: string
  method: string
  route?: string
  statusCode: number
  outcome: 'finished' | 'aborted'
  durationMs: number
  projectId?: string
  jobId?: string
  providerTaskId?: string
}

export type RequestLogSink = (entry: SafeRequestLogEntry) => void

interface RequestIdentity {
  projectId?: string
  jobId?: string
  providerTaskId?: string
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function commonIdentifier(values: unknown[]): string | undefined {
  const identifiers = values.map(safeIdentifier).filter((value): value is string => value !== undefined)
  if (identifiers.length === 0) return undefined
  return identifiers.every((value) => value === identifiers[0]) ? identifiers[0] : undefined
}

/**
 * Reads only allow-listed server response identity fields. It never walks or
 * serializes arbitrary response content, prompts, source text, errors, or
 * request payloads.
 */
function identityFromResponseBody(body: unknown): RequestIdentity {
  const top = record(body)
  if (!top) return {}
  const project = record(top.project)
  const job = record(top.job)
  const pipelineRun = record(top.pipelineRun)
  const exported = record(top.export)
  const qualityReport = record(top.qualityReport)
  const asset = record(top.asset)
  const jobs = Array.isArray(top.jobs)
    ? top.jobs.map(record).filter((value): value is Record<string, unknown> => value !== undefined)
    : []
  return {
    projectId: safeIdentifier(top.projectId)
      ?? safeIdentifier(project?.id)
      ?? safeIdentifier(job?.projectId)
      ?? safeIdentifier(pipelineRun?.projectId)
      ?? safeIdentifier(exported?.projectId)
      ?? safeIdentifier(qualityReport?.projectId)
      ?? safeIdentifier(asset?.projectId)
      ?? commonIdentifier(jobs.map((value) => value.projectId)),
    jobId: safeIdentifier(top.jobId)
      ?? safeIdentifier(job?.id)
      ?? commonIdentifier(jobs.map((value) => value.id)),
    providerTaskId: safeIdentifier(top.providerTaskId)
      ?? safeIdentifier(job?.externalTaskId)
      ?? commonIdentifier(jobs.map((value) => value.externalTaskId)),
  }
}

function identityFromPath(pathname: string): RequestIdentity {
  const project = /^\/api\/v1\/projects\/([^/]+)/.exec(pathname)
  const versionedJob = /^\/api\/v1\/jobs\/([^/]+)/.exec(pathname)
  const legacyJob = /^\/api\/jobs\/([^/]+)/.exec(pathname)
  return {
    projectId: safeIdentifier(project?.[1]),
    jobId: safeIdentifier(versionedJob?.[1] ?? legacyJob?.[1]),
  }
}

function safeRoute(request: Request): string | undefined {
  const routePath = record(request.route)?.path
  if (typeof routePath !== 'string') return undefined
  const value = `${request.baseUrl}${routePath}`
  if (!value || value.length > MAX_ROUTE_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return undefined
  return value
}

export function defaultRequestLogSink(entry: SafeRequestLogEntry): void {
  // Node's test runner gives every test child this marker. Tests can still
  // inject a sink to assert the exact production log contract without making
  // the full suite emit thousands of operational lines.
  if (process.env.NODE_TEST_CONTEXT) return
  console.info(JSON.stringify(entry))
}

export function createSafeRequestLogger(sink: RequestLogSink = defaultRequestLogSink): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const started = process.hrtime.bigint()
    const requestId = randomUUID()
    const pathIdentity = identityFromPath(request.path)
    let responseIdentity: RequestIdentity = {}
    let emitted = false
    const originalJson = response.json.bind(response)
    response.json = ((body: unknown) => {
      responseIdentity = identityFromResponseBody(body)
      return originalJson(body)
    }) as Response['json']
    response.setHeader('X-Request-Id', requestId)

    const emit = (outcome: SafeRequestLogEntry['outcome']) => {
      if (emitted) return
      emitted = true
      const elapsedNanoseconds = process.hrtime.bigint() - started
      const durationMs = Math.round(Number(elapsedNanoseconds) / 1_000) / 1_000
      const entry: SafeRequestLogEntry = {
        event: 'http.request',
        requestId,
        method: request.method,
        ...(safeRoute(request) ? { route: safeRoute(request) } : {}),
        statusCode: response.statusCode,
        outcome,
        durationMs,
        ...(responseIdentity.projectId ?? pathIdentity.projectId
          ? { projectId: responseIdentity.projectId ?? pathIdentity.projectId }
          : {}),
        ...(responseIdentity.jobId ?? pathIdentity.jobId
          ? { jobId: responseIdentity.jobId ?? pathIdentity.jobId }
          : {}),
        ...(responseIdentity.providerTaskId
          ? { providerTaskId: responseIdentity.providerTaskId }
          : {}),
      }
      try {
        sink(entry)
      } catch {
        // Logging is observational and must never turn a completed request
        // into an application failure.
      }
    }
    response.once('finish', () => emit('finished'))
    response.once('close', () => emit(response.writableFinished ? 'finished' : 'aborted'))
    next()
  }
}
