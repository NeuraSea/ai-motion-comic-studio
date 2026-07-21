import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initializeDatabase } from './database.js'
import {
  providerPlatformCostPolicy,
  withProviderPlatformCostPolicy,
} from './provider-cost-policy.js'
import { seedProviderCatalogConnections } from './repositories.js'

test('platform policy makes every text Provider free while media remains billable', () => {
  assert.deepEqual(providerPlatformCostPolicy('text'), {
    version: 1,
    costClass: 'free-llm',
    billable: false,
    paidConfirmationRequired: false,
    upstreamProviderBilling: 'outside-platform-policy',
  })
  for (const kind of ['image', 'video', 'speech'] as const) {
    assert.deepEqual(providerPlatformCostPolicy(kind), {
      version: 1,
      costClass: 'billable-media',
      billable: true,
      paidConfirmationRequired: true,
      upstreamProviderBilling: 'outside-platform-policy',
    })
  }
})

test('platform policy is namespaced, preserves usage, and cannot be downgraded by callers', () => {
  const classified = withProviderPlatformCostPolicy('speech', {
    providerId: 'minimax-speech',
    usageCharacters: 42,
    platformPolicy: {
      version: 1,
      costClass: 'free-llm',
      billable: false,
      paidConfirmationRequired: false,
      upstreamProviderBilling: 'outside-platform-policy',
    },
  })
  assert.equal(classified.providerId, 'minimax-speech')
  assert.equal(classified.usageCharacters, 42)
  assert.deepEqual(classified.platformPolicy, providerPlatformCostPolicy('speech'))
})

test('database persists policy for new jobs and derives it for historical null-cost rows', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    seedProviderCatalogConnections(database)
    database.createProject({ id: 'project-cost-policy', title: 'Cost policy' })
    const text = database.createGenerationJob({
      id: 'job-text',
      projectId: 'project-cost-policy',
      type: 'future.agent.reason',
      providerId: 'codex-tools-text',
      providerConfigRevision: 1,
      model: 'gpt-5.5',
      input: {},
    })
    assert.deepEqual(text.cost?.platformPolicy, providerPlatformCostPolicy('text'))

    const persisted = database.withSql((sql) => sql.get(
      'SELECT cost_json FROM generation_jobs WHERE id = ?',
      text.id,
    ))
    assert.equal(typeof persisted?.cost_json, 'string')
    assert.deepEqual(
      JSON.parse(persisted?.cost_json as string).platformPolicy,
      providerPlatformCostPolicy('text'),
    )

    database.updateGenerationJob(text.id, {
      cost: {
        providerUsageUnits: 9,
        platformPolicy: providerPlatformCostPolicy('image'),
      },
    })
    const updated = database.getGenerationJob(text.id)
    assert.equal(updated?.cost?.providerUsageUnits, 9)
    assert.deepEqual(updated?.cost?.platformPolicy, providerPlatformCostPolicy('text'))

    // Simulate a pre-policy row. Read projection still uses the immutable
    // Provider revision, so null never means "unknown billing class".
    database.withSql((sql) => sql.run(
      'UPDATE generation_jobs SET cost_json = NULL WHERE id = ?',
      text.id,
    ))
    assert.deepEqual(
      database.getGenerationJob(text.id)?.cost?.platformPolicy,
      providerPlatformCostPolicy('text'),
    )

    const media = database.createGenerationJob({
      id: 'job-video',
      projectId: 'project-cost-policy',
      type: 'shot.video.generate',
      providerId: 'seedance-video',
      providerConfigRevision: 1,
      model: 'doubao-seedance-2-0-260128',
      input: {},
    })
    assert.deepEqual(media.cost?.platformPolicy, providerPlatformCostPolicy('video'))
  } finally {
    database.close()
  }
})
