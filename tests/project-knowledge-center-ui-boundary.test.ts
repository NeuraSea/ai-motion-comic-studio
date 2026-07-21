import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sourcePath = new URL('../src/features/catalog/ProjectKnowledgeCenter.tsx', import.meta.url)

test('project knowledge catalog exposes structured world, event, relation and immutable history workflows', async () => {
  const source = await readFile(sourcePath, 'utf8')
  assert.match(source, /世界观总纲/)
  assert.match(source, /结构化设定条目/)
  assert.match(source, /按因果顺序排列事件/)
  assert.match(source, /人物关系图/)
  assert.match(source, /projectRelationshipGraph/)
  assert.match(source, /不可变修订历史/)
  assert.match(source, /restoreProjectKnowledgeRevision/)
  assert.match(source, /getProjectKnowledgeSnapshot/)
  assert.match(source, /listProjectKnowledgeRevisions/)
  assert.match(source, /snapshot\.etag/)
  assert.match(source, /当前有未保存草稿/)
  assert.match(source, /importProjectSourceText/)
  assert.match(source, /readProjectSourceImport/)
  assert.match(source, /导入 \.txt \/ \.md/)
  assert.match(source, /不会覆盖结构化世界观、事件线、人物关系或任何单集制作数据/)
})

test('knowledge restore creates a new head and never claims to rewrite episode production', async () => {
  const source = await readFile(sourcePath, 'utf8')
  assert.match(source, /创建新的项目修订/)
  assert.match(source, /单集已经固定的制作素材也不会被改写/)
  assert.doesNotMatch(source, /直接覆盖历史/)
})
