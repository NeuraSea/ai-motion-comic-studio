import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StudioEventHub } from './events.js'

test('event hub filters projects and replays events after an id', () => {
  const hub = new StudioEventHub(3, { streamId: 'boot-a' })
  const received: string[] = []
  const unsubscribe = hub.subscribe({ projectId: 'project-a' }, (event) => received.push(event.id))

  const first = hub.publish('job.created', { jobId: 'one' }, { projectId: 'project-a' })
  hub.publish('job.created', { jobId: 'two' }, { projectId: 'project-b' })
  const third = hub.publish('job.updated', { jobId: 'one', status: 'running' }, { projectId: 'project-a' })
  hub.publish('provider.updated', { providerId: 'image' })

  assert.deepEqual(received, [first.id, third.id])
  assert.deepEqual(hub.since(first.id, { projectId: 'project-a' }).map((event) => event.id), [third.id])
  assert.equal(hub.since().length, 3, 'bounded history should discard the oldest event')

  unsubscribe()
  assert.equal(hub.subscriberCount, 0)
})

test('event listeners receive isolated payload copies', () => {
  const hub = new StudioEventHub(undefined, { streamId: 'boot-a' })
  hub.subscribe({}, (event) => {
    if (typeof event.data === 'object' && event.data && !Array.isArray(event.data)) {
      event.data.changed = true
    }
  })

  const published = hub.publish('project.updated', { changed: false })
  const replayed = hub.since()[0]
  assert.deepEqual(published.data, { changed: false })
  assert.deepEqual(replayed.data, { changed: false })
})

test('event ids are unique per process boot and an old Last-Event-ID requests a resync', () => {
  const previousBoot = new StudioEventHub(10, { streamId: 'previous-boot' })
  const previous = previousBoot.publish('job.updated', { jobId: 'old' })
  const currentBoot = new StudioEventHub(10, { streamId: 'current-boot' })
  const current = currentBoot.publish('job.updated', { jobId: 'current' })

  assert.notEqual(previous.id, current.id)
  const replay = currentBoot.replay(previous.id)
  assert.equal(replay.resyncReason, 'stream-restarted')
  assert.deepEqual(replay.events.map((event) => event.id), [current.id])
  const control = currentBoot.createResyncEvent(replay.resyncReason!)
  assert.equal(control.id, 'current-boot:1')
  assert.equal(control.type, 'stream.resync')
  assert.deepEqual(control.data, { reason: 'stream-restarted' })
})

test('event replay detects a cursor older than bounded process history', () => {
  const hub = new StudioEventHub(2, { streamId: 'boot-a' })
  const discarded = hub.publish('job.created', { jobId: 'one' })
  hub.publish('job.updated', { jobId: 'two' })
  const retained = hub.publish('job.updated', { jobId: 'three' })
  const latest = hub.publish('job.updated', { jobId: 'four' })

  const replay = hub.replay(discarded.id)
  assert.equal(replay.resyncReason, 'history-truncated')
  assert.deepEqual(replay.events.map((event) => event.id), [retained.id, latest.id])
  assert.equal(hub.replay(retained.id).resyncReason, undefined)
  assert.deepEqual(hub.since(retained.id).map((event) => event.id), [latest.id])
})
