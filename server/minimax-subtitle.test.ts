import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  downloadMiniMaxSubtitle,
  MiniMaxSubtitleError,
  parseMiniMaxSubtitle,
} from './minimax-subtitle.js'
import { SafePublicDownloadError } from './safe-image-download.js'

test('parses bounded millisecond word and sentence timestamp sidecars', () => {
  assert.deepEqual(parseMiniMaxSubtitle([
    { text: '它', start_time: 0, end_time: 220 },
    { word: '醒了', start_time: 220, end_time: 760 },
  ]), [
    { text: '它', startMs: 0, endMs: 220 },
    { text: '醒了', startMs: 220, endMs: 760 },
  ])
  assert.deepEqual(parseMiniMaxSubtitle({ subtitles: [
    { content: '整句字幕。', begin_time: 10, end_time: 900 },
  ] }), [
    { text: '整句字幕。', startMs: 10, endMs: 900 },
  ])
})

test('rejects malformed, empty, unordered, and unbounded timestamp data', () => {
  for (const value of [
    {},
    [],
    [{ text: '', start_time: 0, end_time: 1 }],
    [{ text: 'x', start_time: 1, end_time: 1 }],
    [{ text: 'x', start_time: -1, end_time: 1 }],
    [
      { text: 'later', start_time: 100, end_time: 200 },
      { text: 'earlier', start_time: 50, end_time: 80 },
    ],
    [
      { text: 'overlap-a', start_time: 0, end_time: 200 },
      { text: 'overlap-b', start_time: 150, end_time: 300 },
    ],
  ]) {
    assert.throws(
      () => parseMiniMaxSubtitle(value),
      (error: unknown) => error instanceof MiniMaxSubtitleError
        && error.code === 'INVALID_SUBTITLE_RESPONSE',
    )
  }
})

test('downloads only a bounded accepted UTF-8 JSON sidecar without retaining its URL', async () => {
  const calls: unknown[][] = []
  const cues = await downloadMiniMaxSubtitle(
    { url: 'https://cdn.minimax.io/fixture.titles?token=secret', granularity: 'word' },
    new AbortController().signal,
    async (...args) => {
      calls.push(args)
      return {
        bytes: Buffer.from(JSON.stringify({ words: [
          { text: '龙', start_ms: 0, end_ms: 300 },
        ] })),
        contentType: 'application/json; charset=utf-8',
      }
    },
  )
  assert.deepEqual(cues, [{ text: '龙', startMs: 0, endMs: 300 }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'https://cdn.minimax.io/fixture.titles?token=secret')
  assert.deepEqual(calls[0][2], {
    maxBytes: 256 * 1024,
    accept: 'application/json,text/json,text/plain;q=0.9,application/octet-stream;q=0.5',
    httpsOnly: true,
  })
})

test('maps unsafe/oversized downloads and rejects non-JSON media types', async () => {
  await assert.rejects(
    downloadMiniMaxSubtitle(
      { url: 'https://cdn.minimax.io/private', granularity: 'word' },
      new AbortController().signal,
      async () => { throw new SafePublicDownloadError('UNSAFE_RESOURCE_URL', 'unsafe', false) },
    ),
    (error: unknown) => error instanceof MiniMaxSubtitleError
      && error.code === 'SUBTITLE_DOWNLOAD_FAILED'
      && error.retryable === false,
  )
  await assert.rejects(
    downloadMiniMaxSubtitle(
      { url: 'https://cdn.minimax.io/large', granularity: 'word' },
      new AbortController().signal,
      async () => { throw new SafePublicDownloadError('RESOURCE_TOO_LARGE', 'large', false) },
    ),
    (error: unknown) => error instanceof MiniMaxSubtitleError
      && error.code === 'SUBTITLE_TOO_LARGE',
  )
  await assert.rejects(
    downloadMiniMaxSubtitle(
      { url: 'https://cdn.minimax.io/html', granularity: 'word' },
      new AbortController().signal,
      async () => ({ bytes: Buffer.from('<html>'), contentType: 'text/html' }),
    ),
    (error: unknown) => error instanceof MiniMaxSubtitleError
      && error.code === 'INVALID_SUBTITLE_RESPONSE',
  )
})
