import assert from 'node:assert/strict'
import test from 'node:test'

import type { GenerationJob } from '../src/lib/index.ts'
import {
  projectJobsReconciliationInterval,
  reduceProjectJobs,
} from '../src/features/jobs/useProjectJobs.ts'

function job(id: string, projectId: string, updatedAt: string): GenerationJob {
  return {
    id,
    projectId,
    type: 'export.render',
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    input: {},
    createdAt: updatedAt,
    updatedAt,
  }
}

test('an authoritative project snapshot replaces jobs missing from the response', () => {
  const stale = job('stale', 'project-a', '2026-07-14T01:00:00.000Z')
  const current = job('current', 'project-a', '2026-07-14T02:00:00.000Z')
  const previous = reduceProjectJobs(new Map(), { type: 'snapshot', jobs: [stale, current] })

  const next = reduceProjectJobs(previous, { type: 'snapshot', jobs: [current] })

  assert.deepEqual([...next.keys()], ['current'])
})

test('scope reset prevents undefined-to-A and A-to-B job leakage while SSE remains an upsert', () => {
  const projectA = job('a', 'project-a', '2026-07-14T01:00:00.000Z')
  const projectB = job('b', 'project-b', '2026-07-14T02:00:00.000Z')
  const projectBUpdate = { ...projectB, progress: 55, status: 'running' as const,
    updatedAt: '2026-07-14T03:00:00.000Z' }

  let state = reduceProjectJobs(new Map(), { type: 'reset' })
  state = reduceProjectJobs(state, { type: 'snapshot', jobs: [projectA] })
  assert.deepEqual([...state.keys()], ['a'])

  state = reduceProjectJobs(state, { type: 'reset' })
  state = reduceProjectJobs(state, { type: 'snapshot', jobs: [projectB] })
  state = reduceProjectJobs(state, { type: 'upsert', job: projectBUpdate })

  assert.deepEqual([...state.keys()], ['b'])
  assert.equal(state.get('b')?.progress, 55)
})

test('active durable jobs poll quickly even while SSE reports live', () => {
  assert.equal(projectJobsReconciliationInterval(1, 'live'), 1_000)
  assert.equal(projectJobsReconciliationInterval(4, 'degraded'), 1_000)
  assert.equal(projectJobsReconciliationInterval(0, 'degraded'), 3_000)
  assert.equal(projectJobsReconciliationInterval(0, 'live'), 15_000)
})
