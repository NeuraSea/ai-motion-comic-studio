import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'

import type { JsonValue } from './types.js'

export type StudioEventType =
  | 'job.created'
  | 'job.updated'
  | 'pipeline.updated'
  | 'project.updated'
  | 'provider.updated'
  | 'asset.created'
  | 'stream.resync'

export interface StudioEvent {
  id: string
  type: StudioEventType
  createdAt: string
  projectId?: string
  data: JsonValue
}

export interface StudioEventFilter {
  projectId?: string
}

type EventListener = (event: StudioEvent) => void

export type StudioResyncReason = 'history-truncated' | 'invalid-cursor' | 'stream-restarted'

export interface StudioEventReplay {
  events: StudioEvent[]
  resyncReason?: StudioResyncReason
}

const DEFAULT_HISTORY_LIMIT = 500

/**
 * Process-local event fan-out for the local MVP. Durable state always lives in
 * SQLite; this history only lets a briefly disconnected SSE client catch up.
 */
export class StudioEventHub {
  readonly streamId: string
  private nextSequence = 1
  private readonly history: StudioEvent[] = []
  private readonly listeners = new Map<number, { filter: StudioEventFilter; listener: EventListener }>()
  private nextListenerId = 1

  constructor(
    private readonly historyLimit = DEFAULT_HISTORY_LIMIT,
    options: { streamId?: string } = {},
  ) {
    if (!Number.isInteger(historyLimit) || historyLimit < 1) {
      throw new Error('historyLimit must be a positive integer')
    }
    const streamId = options.streamId ?? `${Date.now().toString(36)}-${randomUUID()}`
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(streamId)) {
      throw new Error('streamId must be a safe SSE id segment')
    }
    this.streamId = streamId
  }

  publish(
    type: StudioEventType,
    data: JsonValue,
    options: { projectId?: string } = {},
  ): StudioEvent {
    const event: StudioEvent = {
      id: this.eventId(this.nextSequence++),
      type,
      createdAt: new Date().toISOString(),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      data: structuredClone(data),
    }
    this.history.push(event)
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit)
    }
    for (const { filter, listener } of this.listeners.values()) {
      if (filter.projectId && event.projectId !== filter.projectId) continue
      listener(structuredClone(event))
    }
    return structuredClone(event)
  }

  /**
   * Resolves an SSE cursor against this process-local history. Event IDs carry
   * a unique boot stream ID, so an ID from a previous process can never hide
   * all events merely because its old numeric counter was larger.
   */
  replay(lastEventId?: string, filter: StudioEventFilter = {}): StudioEventReplay {
    const allFiltered = () => this.history
      .filter((event) => !filter.projectId || event.projectId === filter.projectId)
      .map((event) => structuredClone(event))

    if (!lastEventId) return { events: allFiltered() }

    const prefix = `${this.streamId}:`
    if (!lastEventId.startsWith(prefix)) {
      return { events: allFiltered(), resyncReason: 'stream-restarted' }
    }
    const rawSequence = lastEventId.slice(prefix.length)
    if (!/^(?:0|[1-9][0-9]*)$/.test(rawSequence)) {
      return { events: allFiltered(), resyncReason: 'invalid-cursor' }
    }
    const sequence = Number(rawSequence)
    const latestSequence = this.nextSequence - 1
    if (!Number.isSafeInteger(sequence) || sequence > latestSequence) {
      return { events: allFiltered(), resyncReason: 'invalid-cursor' }
    }

    const oldestSequence = this.history.length
      ? this.sequenceOf(this.history[0].id)
      : this.nextSequence
    if (sequence < oldestSequence - 1) {
      return { events: allFiltered(), resyncReason: 'history-truncated' }
    }

    return {
      events: this.history
        .filter((event) => (
          this.sequenceOf(event.id) > sequence &&
          (!filter.projectId || event.projectId === filter.projectId)
        ))
        .map((event) => structuredClone(event)),
    }
  }

  since(lastEventId?: string, filter: StudioEventFilter = {}): StudioEvent[] {
    return this.replay(lastEventId, filter).events
  }

  createResyncEvent(reason: StudioResyncReason): StudioEvent {
    return {
      id: this.eventId(this.nextSequence - 1),
      type: 'stream.resync',
      createdAt: new Date().toISOString(),
      data: { reason },
    }
  }

  subscribe(filter: StudioEventFilter, listener: EventListener): () => void {
    const id = this.nextListenerId++
    this.listeners.set(id, { filter: { ...filter }, listener })
    return () => this.listeners.delete(id)
  }

  get subscriberCount(): number {
    return this.listeners.size
  }

  private eventId(sequence: number): string {
    return `${this.streamId}:${sequence}`
  }

  private sequenceOf(id: string): number {
    return Number(id.slice(this.streamId.length + 1))
  }
}

function writeEvent(response: Response, event: StudioEvent): void {
  response.write(`id: ${event.id}\n`)
  response.write(`event: ${event.type}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

function parseLastEventId(request: Request): string | undefined {
  const value = request.get('last-event-id')?.trim()
  return value || undefined
}

export function serveStudioEvents(
  request: Request,
  response: Response,
  hub: StudioEventHub,
  options: { heartbeatMs?: number } = {},
): void {
  const queryProjectId = typeof request.query.projectId === 'string'
    ? request.query.projectId.trim()
    : ''
  const filter = queryProjectId ? { projectId: queryProjectId } : {}
  const heartbeatMs = Math.min(Math.max(options.heartbeatMs ?? 15_000, 1_000), 60_000)

  response.status(200)
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  response.setHeader('Cache-Control', 'no-cache, no-transform')
  response.setHeader('Connection', 'keep-alive')
  response.setHeader('X-Accel-Buffering', 'no')
  response.flushHeaders()
  response.write('retry: 2000\n\n')

  const replay = hub.replay(parseLastEventId(request), filter)
  for (const event of replay.events) writeEvent(response, event)
  // A resync control event both tells clients to refresh their durable SQLite
  // snapshot and resets EventSource's cursor to this boot, even if no ordinary
  // event has been published since the process restarted.
  if (replay.resyncReason) writeEvent(response, hub.createResyncEvent(replay.resyncReason))
  const unsubscribe = hub.subscribe(filter, (event) => writeEvent(response, event))
  const heartbeat = setInterval(() => response.write(`: heartbeat ${Date.now()}\n\n`), heartbeatMs)
  heartbeat.unref()

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
  }
  request.once('close', close)
  response.once('close', close)
  response.once('finish', close)
}
