import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ImageJob, ImageJobStatus, JsonObject, PersistedState } from './types.js'

const MAX_STORED_JOBS = 1_000

export type CreateQueuedJobResult =
  | { ok: true; job: ImageJob }
  | { ok: false; reason: 'queue-full' }
  | { ok: false; reason: 'active-retry'; existingJobId: string }

function clone<T>(value: T): T {
  return structuredClone(value)
}

function initialState(): PersistedState {
  const now = new Date().toISOString()
  return {
    version: 1,
    project: {
      id: 'default',
      title: '未命名漫剧',
      version: 1,
      createdAt: now,
      updatedAt: now,
      settings: {
        imageStyle: '国风动漫',
      },
    },
    jobs: [],
  }
}

function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Partial<PersistedState>
  return state.version === 1 && !!state.project && typeof state.project === 'object' && Array.isArray(state.jobs)
}

export class AtomicStateStore {
  private state: PersistedState = initialState()
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })

    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!isPersistedState(parsed)) throw new Error('状态文件结构无效')
      this.state = parsed
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`
        await rename(this.filePath, corruptPath).catch(() => undefined)
        console.error(`状态文件无法读取，已移至 ${corruptPath}`)
      }
      this.state = initialState()
      await this.persist()
    }

    const recovered = this.recoverInterruptedJobsInMemory()
    if (recovered) await this.persist()
  }

  getProject(): JsonObject {
    return clone(this.state.project)
  }

  async setProject(project: JsonObject): Promise<JsonObject> {
    const now = new Date().toISOString()
    this.state.project = clone({ ...project, updatedAt: now })
    await this.persist()
    return this.getProject()
  }

  listJobs(options: { limit: number; status?: ImageJobStatus }): ImageJob[] {
    const jobs = options.status
      ? this.state.jobs.filter((job) => job.status === options.status)
      : this.state.jobs
    return clone(jobs.slice(-options.limit).reverse())
  }

  listQueuedJobIds(): string[] {
    return this.state.jobs.filter((job) => job.status === 'queued').map((job) => job.id)
  }

  getJob(id: string): ImageJob | undefined {
    const job = this.state.jobs.find((candidate) => candidate.id === id)
    return job ? clone(job) : undefined
  }

  async createQueuedJob(job: ImageJob, maxActiveJobs: number): Promise<CreateQueuedJobResult> {
    const activeJobs = this.state.jobs.filter((candidate) =>
      candidate.status === 'queued' || candidate.status === 'running')
    if (job.retryOf) {
      const existingRetry = activeJobs.find((candidate) => candidate.retryOf === job.retryOf)
      if (existingRetry) {
        return { ok: false, reason: 'active-retry', existingJobId: existingRetry.id }
      }
    }
    if (activeJobs.length >= maxActiveJobs) return { ok: false, reason: 'queue-full' }

    this.pruneFinishedJobs()
    this.state.jobs.push(clone(job))
    await this.persist()
    return { ok: true, job: clone(job) }
  }

  async updateJob(id: string, update: Partial<ImageJob>): Promise<ImageJob> {
    const index = this.state.jobs.findIndex((job) => job.id === id)
    if (index < 0) throw new Error(`Job not found: ${id}`)

    const current = this.state.jobs[index]
    const next = {
      ...current,
      ...clone(update),
      id: current.id,
      type: current.type,
      updatedAt: new Date().toISOString(),
    }
    this.state.jobs[index] = next
    await this.persist()
    return clone(next)
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  private recoverInterruptedJobsInMemory(): boolean {
    let recovered = false
    const now = new Date().toISOString()
    this.state.jobs = this.state.jobs.map((job) => {
      if (job.status !== 'running') return job
      recovered = true
      const { startedAt: _startedAt, completedAt: _completedAt, output: _output, error: _error, ...rest } = job
      return { ...rest, status: 'queued', progress: 0, updatedAt: now }
    })
    return recovered
  }

  private pruneFinishedJobs(): void {
    if (this.state.jobs.length < MAX_STORED_JOBS) return
    const removable = this.state.jobs.length - MAX_STORED_JOBS + 1
    let removed = 0
    this.state.jobs = this.state.jobs.filter((job) => {
      if (removed < removable && (job.status === 'succeeded' || job.status === 'failed')) {
        removed += 1
        return false
      }
      return true
    })
  }

  private persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`
    const write = async () => {
      const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        const handle = await open(tempPath, 'wx', 0o600)
        try {
          await handle.writeFile(serialized, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(tempPath, this.filePath)
      } catch (error) {
        await unlink(tempPath).catch(() => undefined)
        throw error
      }
    }

    const pending = this.writeChain.then(write, write)
    this.writeChain = pending.catch(() => undefined)
    return pending
  }
}
