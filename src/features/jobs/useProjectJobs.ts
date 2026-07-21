import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'

import {
  api,
  generationJobFromEventData,
  type GenerationJob,
  type StudioEvent,
} from '../../lib'

type JobMap = Map<string, GenerationJob>

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function mergeJob(target: JobMap, job: GenerationJob): JobMap {
  const current = target.get(job.id)
  if (current && timestamp(current.updatedAt) > timestamp(job.updatedAt)) return target
  const next = new Map(target)
  next.set(job.id, job)
  if (next.size > 200) {
    const removable = [...next.values()]
      .filter((candidate) => ['succeeded', 'failed', 'cancelled'].includes(candidate.status))
      .sort((a, b) => timestamp(a.updatedAt) - timestamp(b.updatedAt))
    while (next.size > 200 && removable.length) next.delete(removable.shift()!.id)
  }
  return next
}

type Action =
  | { type: 'snapshot'; jobs: GenerationJob[] }
  | { type: 'upsert'; job: GenerationJob }
  | { type: 'reset' }

export function reduceProjectJobs(state: JobMap, action: Action): JobMap {
  if (action.type === 'reset') return new Map()
  if (action.type === 'upsert') return mergeJob(state, action.job)
  let next: JobMap = new Map()
  for (const job of action.jobs) next = mergeJob(next, job)
  return next
}

export type JobConnectionState = 'connecting' | 'live' | 'degraded'

/**
 * SSE is an acceleration channel, never the durable source of truth. Active
 * jobs reconcile quickly so a missed terminal event cannot leave paid work at
 * "100% running" forever; idle tabs back off to a cheap safety snapshot.
 */
export function projectJobsReconciliationInterval(
  activeCount: number,
  connection: JobConnectionState,
): number {
  if (activeCount > 0) return 1_000
  return connection === 'degraded' ? 3_000 : 15_000
}

export function useProjectJobs(projectId?: string) {
  const [state, dispatch] = useReducer(reduceProjectJobs, new Map())
  const [connection, setConnection] = useState<JobConnectionState>('connecting')
  const [error, setError] = useState('')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) {
      if (!signal?.aborted) dispatch({ type: 'snapshot', jobs: [] })
      return []
    }
    const jobs = await api.listGenerationJobs({ projectId, limit: 200, signal })
    if (!signal?.aborted) dispatch({ type: 'snapshot', jobs })
    return jobs
  }, [projectId])

  const remember = useCallback(<TInput, TOutput>(job: GenerationJob<TInput, TOutput>) => {
    if (!projectId || job.projectId !== projectId) return
    dispatch({ type: 'upsert', job: job as GenerationJob })
  }, [projectId])

  useEffect(() => {
    dispatch({ type: 'reset' })
    setConnection('connecting')
    setError('')
    if (!projectId) return
    const controller = new AbortController()
    let reconnectRefresh: number | undefined
    void refresh(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setConnection('degraded')
        setError(reason instanceof Error ? reason.message : '无法获取任务状态')
      }
    })

    const stream = api.openStudioEventStream(projectId)
    stream.onopen = () => {
      setConnection('live')
      setError('')
      void refresh(controller.signal).catch(() => undefined)
    }
    const onJobEvent = (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as StudioEvent
        const job = generationJobFromEventData(envelope.data)
        if (job?.projectId === projectId) dispatch({ type: 'upsert', job })
      } catch {
        // A malformed event is ignored; the reconnect snapshot remains authoritative.
      }
    }
    const onResync = () => {
      void refresh(controller.signal).catch(() => undefined)
    }
    for (const type of ['job.created', 'job.updated']) stream.addEventListener(type, onJobEvent as EventListener)
    stream.addEventListener('stream.resync', onResync)
    stream.onerror = () => {
      setConnection('degraded')
      setError('任务实时连接已断开，正在自动重连')
      if (reconnectRefresh !== undefined) window.clearTimeout(reconnectRefresh)
      reconnectRefresh = window.setTimeout(() => void refresh(controller.signal).catch(() => undefined), 2_500)
    }
    return () => {
      controller.abort()
      stream.close()
      if (reconnectRefresh !== undefined) window.clearTimeout(reconnectRefresh)
    }
  }, [projectId, refresh])

  const jobs = useMemo(
    () => [...state.values()].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt)),
    [state],
  )
  const activeCount = useMemo(
    () => jobs.filter((job) => ['queued', 'running', 'waiting_provider'].includes(job.status)).length,
    [jobs],
  )

  useEffect(() => {
    if (!projectId) return
    const controller = new AbortController()
    let inFlight = false
    const reconcile = async () => {
      if (inFlight || controller.signal.aborted) return
      inFlight = true
      try {
        await refresh(controller.signal)
      } catch (reason) {
        if (!controller.signal.aborted) {
          setConnection('degraded')
          setError(reason instanceof Error ? reason.message : '无法核对任务持久状态')
        }
      } finally {
        inFlight = false
      }
    }
    const interval = window.setInterval(
      () => void reconcile(),
      projectJobsReconciliationInterval(activeCount, connection),
    )
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [activeCount, connection, projectId, refresh])

  return { jobs, activeCount, connection, error, refresh, remember }
}
