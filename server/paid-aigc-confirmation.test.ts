import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PaidAigcConfirmationGate,
  paidAigcActions,
  type PaidAigcConfirmationIntent,
} from './paid-aigc-confirmation.js'

function intent(overrides: Partial<PaidAigcConfirmationIntent> = {}): PaidAigcConfirmationIntent {
  return {
    action: 'asset.image.generate',
    projectId: 'project-1',
    episodeId: 'episode-1',
    resourceId: 'episode-1',
    idempotencyKey: 'story-generation-root-key',
    provider: {
      providerId: 'codex-tools-text',
      model: 'gpt-5.5',
      configRevision: 3,
    },
    input: {
      expectedRevisionId: 'revision-1',
      sourceText: '不会出现在公开预检中的原著正文',
      nested: { z: true, a: 24 },
    },
    ...overrides,
  }
}

test('paid AIGC confirmation authenticates the exact idempotent immutable intent', () => {
  const gate = new PaidAigcConfirmationGate({
    secret: Buffer.alloc(32, 7),
    now: () => new Date('2026-07-15T00:00:00.000Z'),
  })
  const challenge = gate.issue(intent(), '生成结构剧本')

  assert.equal(gate.verify(intent(), challenge.confirmationToken), 'valid')
  assert.match(challenge.confirmationToken, /^aigcpf1_[1-9][0-9]{9,12}_[a-f0-9]{64}$/)
  assert.match(challenge.intentFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(challenge.billableTaskCount, 1)
  assert.equal(challenge.priceEstimate, null)
  assert.equal(challenge.provider.configRevision, 3)
  assert.ok(!JSON.stringify(challenge).includes('原著正文'))
  assert.ok(!JSON.stringify(challenge).includes(Buffer.alloc(32, 7).toString('hex')))
})

test('confirmation is stable across object key order but rejects every paid binding drift', () => {
  const gate = new PaidAigcConfirmationGate({
    secret: Buffer.alloc(32, 11),
    now: () => new Date('2026-07-15T00:00:00.000Z'),
  })
  const challenge = gate.issue(intent(), '生成结构剧本')
  const reordered = intent({
    input: {
      nested: { a: 24, z: true },
      sourceText: '不会出现在公开预检中的原著正文',
      expectedRevisionId: 'revision-1',
    },
  })
  assert.equal(gate.verify(reordered, challenge.confirmationToken), 'valid')

  const drifted: PaidAigcConfirmationIntent[] = [
    intent({ idempotencyKey: 'another-root-key' }),
    intent({ resourceId: 'episode-2' }),
    intent({ input: { expectedRevisionId: 'revision-2' } }),
    intent({ provider: { providerId: 'codex-tools-text', model: 'gpt-5.5', configRevision: 4 } }),
    intent({ action: 'character.voice.preview' }),
  ]
  for (const value of drifted) {
    assert.equal(gate.verify(value, challenge.confirmationToken), 'invalid')
  }
})

test('free LLM operations are outside the paid confirmation action registry', () => {
  const registered = new Set<string>(paidAigcActions)
  assert.deepEqual([...registered].sort(), [
    'asset.image.edit',
    'asset.image.generate',
    'character.voice.preview',
    'dialogue.speech.generate',
    'project.narrator.voice.preview',
  ])
  for (const freeOperation of [
    'story.generate',
    'dialogue.performance.recommend',
    'character.voice.recommend',
    'shot.video.reference.analyze',
  ]) {
    assert.equal(registered.has(freeOperation), false, `${freeOperation} must remain free`)
  }
})

test('confirmation expires, is boot scoped, and malformed tokens fail closed', () => {
  let now = new Date('2026-07-15T00:00:00.000Z')
  const gate = new PaidAigcConfirmationGate({
    secret: Buffer.alloc(32, 13),
    ttlSeconds: 30,
    now: () => now,
  })
  const challenge = gate.issue(intent(), '生成结构剧本')
  now = new Date('2026-07-15T00:00:30.000Z')
  assert.equal(gate.verify(intent(), challenge.confirmationToken), 'expired')
  const nextBoot = new PaidAigcConfirmationGate({
    secret: Buffer.alloc(32, 14),
    now: () => new Date('2026-07-15T00:00:10.000Z'),
  })
  assert.equal(nextBoot.verify(intent(), challenge.confirmationToken), 'invalid')
  assert.equal(gate.verify(intent(), 'aigcpf1_invalid'), 'invalid')
})

test('confirmation construction rejects weak secrets and unsafe or non-canonical inputs', () => {
  assert.throws(() => new PaidAigcConfirmationGate({ secret: Buffer.alloc(31) }), /secret/)
  const gate = new PaidAigcConfirmationGate({ secret: Buffer.alloc(32, 17) })
  assert.throws(() => gate.issue(intent({ projectId: '  ' }), '生成结构剧本'), /projectId/)
  assert.throws(() => gate.issue(intent({
    input: { duration: Number.POSITIVE_INFINITY },
  }), '生成结构剧本'), /non-finite/)
})
