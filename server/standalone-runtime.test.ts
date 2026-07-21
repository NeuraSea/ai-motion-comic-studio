import assert from 'node:assert/strict'
import test from 'node:test'

import { startStandaloneRuntime } from './standalone-runtime.js'

test('release audit failure happens before the server can listen', async () => {
  let started = false
  await assert.rejects(startStandaloneRuntime({
    environment: { MANJU_FFMPEG_RELEASE_MODE: '1' },
    assertReleaseRuntime() {
      throw new Error('fixture release gate closed')
    },
    async startServer() {
      started = true
    },
  }), /release gate closed/)
  assert.equal(started, false)
})

test('development startup does not invoke the release-only gate', async () => {
  let started = false
  await startStandaloneRuntime({
    environment: {},
    assertReleaseRuntime() {
      assert.fail('development startup must not invoke the release gate')
    },
    async startServer() {
      started = true
    },
  })
  assert.equal(started, true)
})
