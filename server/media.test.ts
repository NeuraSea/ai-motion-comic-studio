import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import { MediaStore, MediaStoreError, detectMediaMime, imageDimensions } from './media.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function fixture(): Promise<{ directory: string; database: ManjuDatabase; media: MediaStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'manju-media-test-'))
  const database = initializeDatabase({ runtimeDirectory: directory, legacyStatePath: false })
  database.createProject({ id: 'project-one', title: '媒体测试' })
  const media = new MediaStore(database, { runtimeDirectory: directory })
  await media.init()
  cleanups.push(async () => {
    database.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, database, media }
}

test('detects supported media from magic bytes rather than file names', () => {
  assert.equal(detectMediaMime(ONE_PIXEL_PNG), 'image/png')
  assert.deepEqual(imageDimensions(ONE_PIXEL_PNG, 'image/png'), { width: 1, height: 1 })
  assert.equal(detectMediaMime(Buffer.from('RIFFxxxxWAVEfmt ')), 'audio/wav')
  assert.throws(() => detectMediaMime(Buffer.from('<svg><script>')), /(?:识别|支持)/)
})

test('saves immutable media, registers checksum metadata, and opens it by asset id', async () => {
  const { directory, database, media } = await fixture()
  const asset = await media.save({
    projectId: 'project-one',
    kind: 'storyboard',
    bytes: ONE_PIXEL_PNG,
    mimeType: 'image/png',
    source: 'generated',
    generationParameters: { prompt: '无敏感信息测试' },
    width: 1,
    height: 1,
  })

  assert.match(asset.filePath ?? '', /^media\//)
  assert.equal(asset.mimeType, 'image/png')
  assert.match(asset.checksum ?? '', /^[a-f0-9]{64}$/)
  assert.deepEqual(database.getMediaAsset(asset.id), asset)
  assert.deepEqual(await readFile(join(directory, asset.filePath!)), ONE_PIXEL_PNG)

  const opened = await media.openAsset(asset.id)
  try {
    assert.equal(opened.mimeType, 'image/png')
    assert.equal(opened.size, ONE_PIXEL_PNG.length)
  } finally {
    await opened.file.close()
  }
})

test('rolls back both the asset row and published file when a relational link fails', async () => {
  const { directory, database, media } = await fixture()
  await assert.rejects(
    media.save({
      id: 'rolled-back-asset',
      projectId: 'project-one',
      kind: 'speech',
      bytes: Buffer.from('RIFFxxxxWAVEfmt '),
      mimeType: 'audio/wav',
      source: 'provider',
    }, {
      afterCreate(asset, transaction) {
        assert.equal(transaction.getMediaAsset(asset.id)?.id, asset.id)
        throw new Error('fixture link failure')
      },
    }),
    /fixture link failure/,
  )
  assert.equal(database.getMediaAsset('rolled-back-asset'), undefined)
  const entries = await readdir(join(directory, 'media'), { recursive: true })
  assert.equal(entries.some((entry) => String(entry).includes('rolled-back-asset')), false)
})

test('rejects MIME spoofing and stored path traversal', async () => {
  const { directory, database, media } = await fixture()
  await assert.rejects(
    media.save({
      projectId: 'project-one',
      kind: 'storyboard',
      bytes: ONE_PIXEL_PNG,
      mimeType: 'image/jpeg',
      source: 'upload',
    }),
    (error: unknown) => error instanceof MediaStoreError && error.code === 'INVALID_MEDIA',
  )

  await writeFile(join(directory, 'outside.png'), ONE_PIXEL_PNG)
  const unsafe = database.createMediaAsset({
    projectId: 'project-one',
    kind: 'storyboard',
    filePath: '../outside.png',
    mimeType: 'image/png',
    source: 'fixture',
  })
  await assert.rejects(
    media.openAsset(unsafe.id),
    (error: unknown) => error instanceof MediaStoreError && error.code === 'UNSAFE_MEDIA_PATH',
  )
})

test('rejects caller supplied asset IDs that are not safe path segments', async () => {
  const { directory, media } = await fixture()
  await assert.rejects(
    media.save({
      id: '../escaped',
      projectId: 'project-one',
      kind: 'storyboard',
      bytes: ONE_PIXEL_PNG,
      mimeType: 'image/png',
      source: 'upload',
    }),
    (error: unknown) => error instanceof MediaStoreError && error.code === 'UNSAFE_MEDIA_PATH',
  )
  assert.equal((await readdir(directory)).includes('escaped.png'), false)
})

test('rejects a symlinked media directory before writing outside the runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manju-media-link-test-'))
  const outside = await mkdtemp(join(tmpdir(), 'manju-media-outside-'))
  const database = initializeDatabase({ runtimeDirectory: directory, legacyStatePath: false })
  database.createProject({ id: 'project-one', title: '媒体测试' })
  const media = new MediaStore(database, { runtimeDirectory: directory })
  await symlink(outside, join(directory, 'media'), 'dir')
  cleanups.push(async () => {
    database.close()
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ])
  })

  await assert.rejects(
    media.save({
      id: 'must-stay-inside',
      projectId: 'project-one',
      kind: 'storyboard',
      bytes: ONE_PIXEL_PNG,
      source: 'generated',
    }),
    (error: unknown) => error instanceof MediaStoreError && error.code === 'UNSAFE_MEDIA_PATH',
  )
  assert.deepEqual(await readdir(outside), [])
})

test('rejects a symlinked project directory before writing outside the media root', async () => {
  const { directory, media } = await fixture()
  const first = await media.save({
    id: 'first-safe-asset',
    projectId: 'project-one',
    kind: 'storyboard',
    bytes: ONE_PIXEL_PNG,
    source: 'generated',
  })
  const projectDirectory = dirname(join(directory, first.filePath!))
  const outside = await mkdtemp(join(tmpdir(), 'manju-project-outside-'))
  cleanups.push(() => rm(outside, { recursive: true, force: true }))
  await rm(projectDirectory, { recursive: true, force: true })
  await mkdir(dirname(projectDirectory), { recursive: true })
  await symlink(outside, projectDirectory, 'dir')

  await assert.rejects(
    media.save({
      id: 'must-not-escape',
      projectId: 'project-one',
      kind: 'storyboard',
      bytes: ONE_PIXEL_PNG,
      source: 'generated',
    }),
    (error: unknown) => error instanceof MediaStoreError && error.code === 'UNSAFE_MEDIA_PATH',
  )
  assert.deepEqual(await readdir(outside), [])
})

test('opens legacy generated assets without moving or deleting them', async () => {
  const { directory, database, media } = await fixture()
  const legacyDirectory = join(directory, 'generated')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(legacyDirectory, { recursive: true }))
  await writeFile(join(legacyDirectory, 'legacy.png'), ONE_PIXEL_PNG)
  const asset = database.createMediaAsset({
    projectId: 'project-one',
    kind: 'image',
    filePath: 'generated/legacy.png',
    mimeType: 'image/png',
    source: 'legacy-import',
  })

  const opened = await media.openAsset(asset.id)
  await opened.file.close()
  assert.equal(await media.deleteUnreferencedFile(asset), false)
  assert.deepEqual(await readFile(join(legacyDirectory, 'legacy.png')), ONE_PIXEL_PNG)
})

test('a duplicate asset id never overwrites or deletes the immutable original file', async () => {
  const { directory, media } = await fixture()
  const original = await media.save({
    id: 'stable-asset',
    projectId: 'project-one',
    kind: 'storyboard',
    bytes: ONE_PIXEL_PNG,
    mimeType: 'image/png',
    source: 'generated',
  })
  await assert.rejects(
    media.save({
      id: original.id,
      projectId: 'project-one',
      kind: 'storyboard',
      bytes: Buffer.concat([ONE_PIXEL_PNG, Buffer.from('different')]),
      mimeType: 'image/png',
      source: 'generated',
    }),
    (error: unknown) => error instanceof MediaStoreError && error.code === 'ASSET_EXISTS',
  )
  assert.deepEqual(await readFile(join(directory, original.filePath!)), ONE_PIXEL_PNG)
  const opened = await media.openAsset(original.id)
  await opened.file.close()
})
