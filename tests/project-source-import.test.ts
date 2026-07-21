import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROJECT_SOURCE_IMPORT_MAX_BYTES,
  readProjectSourceImport,
} from '../src/features/catalog/project-source-import.ts'

test('project source import accepts UTF-8 txt/markdown and removes only the BOM', async () => {
  const text = await readProjectSourceImport(new File(['\ufeff原著正文\r\n第二行'], '原著.txt', {
    type: 'text/plain',
  }))
  assert.deepEqual(text, {
    fileName: '原著.txt',
    content: '原著正文\r\n第二行',
  })

  const markdown = await readProjectSourceImport(new File(['# 世界'], 'world.MD', {
    type: 'text/markdown',
  }))
  assert.equal(markdown.content, '# 世界')
})

test('project source import rejects paths, unsupported MIME, invalid UTF-8, empty and oversized files', async () => {
  await assert.rejects(
    readProjectSourceImport(new File(['x'], '../story.txt', { type: 'text/plain' })),
    /只支持/,
  )
  await assert.rejects(
    readProjectSourceImport(new File(['x'], 'story.txt', { type: 'application/pdf' })),
    /文件类型/,
  )
  await assert.rejects(
    readProjectSourceImport(new File([new Uint8Array([0xc3, 0x28])], 'story.txt', { type: 'text/plain' })),
    /UTF-8/,
  )
  await assert.rejects(
    readProjectSourceImport(new File([], 'story.txt', { type: 'text/plain' })),
    /必须大于 0 字节/,
  )
  await assert.rejects(
    readProjectSourceImport(new File([new Uint8Array(PROJECT_SOURCE_IMPORT_MAX_BYTES + 1)], 'story.txt', {
      type: 'text/plain',
    })),
    /不超过 2MB/,
  )
})
