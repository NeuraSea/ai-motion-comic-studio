import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initializeDatabase, type ManjuDatabase } from './database.js'
import {
  TextProviderError,
  type StructuredGenerationInput,
  type TextProvider,
} from './providers/text.js'
import {
  STORY_GENERATION_JOB_TYPE,
  STORY_GENERATION_LIMITS,
  StoryGenerationError,
  StoryGenerationService,
  createStoryGenerationJobHandler,
  type StoryGenerationJobInput,
} from './story-generation.js'
import { StoryRepository } from './story-repository.js'
import { STORY_DOCUMENT_JSON_SCHEMA, type StoryDocument } from './story-schema.js'
import type { JobHandlerContext, JobRecord } from './worker.js'

type StubImplementation = (
  input: StructuredGenerationInput,
  validate: (value: unknown) => unknown,
  signal: AbortSignal,
) => Promise<unknown>

class StubTextProvider implements TextProvider {
  readonly name = 'stub-text'
  readonly model = 'stub-structured-v1'
  readonly calls: StructuredGenerationInput[] = []

  constructor(
    private readonly implementation: StubImplementation,
    readonly configured = true,
  ) {}

  async listModels(): Promise<string[]> {
    return [this.model]
  }

  async generateStructured<T>(
    input: StructuredGenerationInput,
    validate: (value: unknown) => T,
    signal: AbortSignal,
  ): Promise<T> {
    this.calls.push(input)
    return await this.implementation(input, validate, signal) as T
  }
}

function story(title: string, detail = '阿离在风中看向云海。'): StoryDocument {
  return {
    version: 1,
    title,
    targetDurationSeconds: 30,
    bible: {
      logline: '少女守护长安。',
      theme: '责任',
      tone: '紧张',
      visualStyle: '国风动画，16:9 电影构图',
    },
    characters: [{
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑色长发、红绳、青色圆领袍',
    }],
    locations: [{
      id: 'cliff',
      name: '断崖',
      storyDescription: '长安城外',
      visualDescription: '云海与落日，青黑色山石',
    }],
    props: [{
      id: 'token',
      name: '青铜令',
      description: '唤醒龙脉',
      visualDescription: '暗红纹路的六边形青铜令',
    }],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '断崖龙吟',
      locationId: 'cliff',
      timeOfDay: '黄昏',
      description: '龙脉苏醒',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `01${String.fromCharCode(65 + index)}`,
        title: `镜头 ${index + 1}`,
        description: detail,
        framing: '中景',
        movement: '缓慢推进',
        transition: index === 5 ? '淡出' : '硬切',
        durationSeconds: 5,
        visualPrompt: '国风动画，16:9，阿离黑发红绳青袍，断崖，黄昏云海，逆光，电影构图。',
        dialogueLines: index === 2 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue' as const,
          speaker: '阿离',
          text: '它醒了。',
        }] : [],
      })),
    }],
  }
}

function fixture(initialStory?: StoryDocument): {
  database: ManjuDatabase
  stories: StoryRepository
  revisionId: string | null
} {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  database.createProject({ id: 'project-1', title: '漫剧 MVP' })
  const stories = new StoryRepository(database)
  stories.ensureEpisode('project-1', {
    id: 'episode-1',
    title: '第 1 集',
    sourceText: '旧原文',
    targetDurationSeconds: 30,
    aspectRatio: '16:9',
    stylePreset: '国风动画',
  })
  const applied = initialStory ? stories.applyStory('episode-1', initialStory) : undefined
  return { database, stories, revisionId: applied?.revision.id ?? null }
}

function input(overrides: Partial<StoryGenerationJobInput> = {}): StoryGenerationJobInput {
  return {
    episodeId: 'episode-1',
    sourceText: '密封原文 SECRET_SOURCE_7c91：阿离在断崖听见龙吟。',
    title: '龙脉初醒',
    targetDurationSeconds: 30,
    aspectRatio: '16:9',
    stylePreset: '国风动画',
    ...overrides,
  }
}

function execution(provider: TextProvider, jobId = 'job-story-stable') {
  return {
    provider,
    jobId,
    projectId: 'project-1',
    signal: new AbortController().signal,
  }
}

test('JobWorker handler generates, validates, and atomically persists a real structured story', async () => {
  const { database, stories } = fixture()
  try {
    const generatedStory = story('龙脉初醒')
    const provider = new StubTextProvider(async (_request, validate) => validate(generatedStory))
    const handler = createStoryGenerationJobHandler({
      stories,
      resolveProvider: async () => provider,
    })
    const job: JobRecord<StoryGenerationJobInput> = {
      id: 'job-story-stable',
      type: STORY_GENERATION_JOB_TYPE,
      status: 'running',
      projectId: 'project-1',
      input: input({ expectedRevisionId: null }),
    }
    const context: JobHandlerContext = {
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
      waitingForProvider: async () => undefined,
    }

    const output = await handler(job, context)

    assert.equal(provider.calls.length, 1)
    const request = provider.calls[0]
    assert.equal(request.schemaName, 'manju_story_document_v1')
    assert.equal(request.schema, STORY_DOCUMENT_JSON_SCHEMA)
    assert.match(request.systemPrompt, /1 到 2 场/)
    assert.match(request.systemPrompt, /6 到 12 个镜头/)
    assert.match(request.systemPrompt, /不得生成或伪造质量分/)
    assert.doesNotMatch(request.systemPrompt, /SECRET_SOURCE_7c91/)
    assert.match(request.userPrompt, /SECRET_SOURCE_7c91/)
    assert.match(request.idempotencyKey ?? '', /^story\.generate:[a-f0-9]{64}$/)
    assert.doesNotMatch(request.idempotencyKey ?? '', /SECRET_SOURCE|job-story-stable/)

    assert.deepEqual(stories.getStory('episode-1'), generatedStory)
    assert.equal(output.title, '龙脉初醒')
    assert.equal(output.sceneCount, 1)
    assert.equal(output.shotCount, 6)
    assert.equal(output.dialogueLineCount, 1)
    assert.equal(output.totalShotDurationSeconds, 30)
    assert.ok(output.revisionId)
    assert.equal('score' in output, false)
  } finally {
    database.close()
  }
})

test('all source, title, duration, aspect, and style limits fail before provider invocation', async () => {
  const { database, stories } = fixture()
  try {
    const provider = new StubTextProvider(async (_request, validate) => validate(story('龙脉初醒')))
    const service = new StoryGenerationService(stories)
    const invalidInputs: Array<Partial<StoryGenerationJobInput>> = [
      { sourceText: '   ' },
      { sourceText: 'x'.repeat(STORY_GENERATION_LIMITS.sourceTextCharacters + 1) },
      { title: '   ' },
      { title: 'x'.repeat(STORY_GENERATION_LIMITS.titleCharacters + 1) },
      { targetDurationSeconds: 29 },
      { targetDurationSeconds: 30.5 },
      { aspectRatio: '4:3' as StoryGenerationJobInput['aspectRatio'] },
      { stylePreset: '   ' },
      { stylePreset: 'x'.repeat(STORY_GENERATION_LIMITS.stylePresetCharacters + 1) },
    ]

    for (const [index, invalid] of invalidInputs.entries()) {
      await assert.rejects(
        service.generate(input(invalid), execution(provider, `invalid-${index}`)),
        (error: unknown) => error instanceof StoryGenerationError
          && error.code === 'STORY_INPUT_INVALID'
          && error.category === 'validation'
          && error.retryable === false,
      )
    }
    assert.equal(provider.calls.length, 0)
    assert.equal(stories.getStory('episode-1'), undefined)
  } finally {
    database.close()
  }
})

test('provider failures expose safe retry metadata, use stable idempotency, and preserve the old story', async () => {
  const oldStory = story('旧剧本')
  const { database, stories, revisionId } = fixture(oldStory)
  try {
    const source = 'SECRET_SOURCE_7c91'
    const provider = new StubTextProvider(async () => {
      throw new TextProviderError(
        'UPSTREAM_UNAVAILABLE',
        `upstream echoed ${source}`,
        true,
      )
    })
    const service = new StoryGenerationService(stories)
    const request = input({ expectedRevisionId: revisionId })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        service.generate(request, execution(provider)),
        (error: unknown) => {
          assert.ok(error instanceof StoryGenerationError)
          assert.equal(error.code, 'STORY_PROVIDER_UNAVAILABLE')
          assert.equal(error.category, 'provider')
          assert.equal(error.retryable, true)
          assert.doesNotMatch(error.message, new RegExp(source))
          assert.equal(error.cause, undefined)
          return true
        },
      )
    }

    assert.equal(provider.calls.length, 2)
    assert.equal(provider.calls[0].idempotencyKey, provider.calls[1].idempotencyKey)
    assert.deepEqual(stories.getStory('episode-1'), oldStory)
    assert.equal(stories.getEpisode('episode-1')?.sourceRevisionId, revisionId)
  } finally {
    database.close()
  }
})

test('a custom provider cannot bypass local output validation or partially overwrite an existing story', async () => {
  const oldStory = story('旧剧本')
  const { database, stories, revisionId } = fixture(oldStory)
  try {
    // Deliberately violates the TextProvider contract by skipping `validate`.
    const provider = new StubTextProvider(async () => ({
      ...story('不应保存'),
      version: 2,
    }))
    const service = new StoryGenerationService(stories)

    await assert.rejects(
      service.generate(
        input({ title: '不应保存', expectedRevisionId: revisionId }),
        execution(provider),
      ),
      (error: unknown) => error instanceof StoryGenerationError
        && error.code === 'STORY_OUTPUT_INVALID'
        && error.retryable === false,
    )

    assert.deepEqual(stories.getStory('episode-1'), oldStory)
    assert.equal(stories.getEpisode('episode-1')?.sourceRevisionId, revisionId)
  } finally {
    database.close()
  }
})

test('a mid-apply database failure rolls the complete story graph back', async () => {
  const oldStory = story('旧剧本')
  const { database, stories, revisionId } = fixture(oldStory)
  try {
    database.withSql((sql) => sql.run(`
      CREATE TRIGGER reject_generated_story
      BEFORE INSERT ON shots
      WHEN NEW.code = 'BLOCK'
      BEGIN
        SELECT RAISE(ABORT, 'blocked by test trigger');
      END
    `))
    const generated = story('新剧本')
    generated.scenes[0].shots[2].code = 'BLOCK'
    const provider = new StubTextProvider(async (_request, validate) => validate(generated))
    const service = new StoryGenerationService(stories)

    await assert.rejects(
      service.generate(
        input({ title: '新剧本', expectedRevisionId: revisionId }),
        execution(provider),
      ),
      (error: unknown) => error instanceof StoryGenerationError
        && error.code === 'STORY_PERSISTENCE_FAILED'
        && error.category === 'internal',
    )

    assert.deepEqual(stories.getStory('episode-1'), oldStory)
    assert.equal(stories.getEpisode('episode-1')?.sourceRevisionId, revisionId)
    assert.equal(database.getProject('project-1')?.currentRevisionId, revisionId)
    assert.equal(database.health().quickCheck, 'ok')
  } finally {
    database.close()
  }
})

test('generation refuses to overwrite a story edited while the provider request is in flight', async () => {
  const oldStory = story('旧剧本')
  const { database, stories, revisionId } = fixture(oldStory)
  try {
    const concurrentStory = story('人工编辑版', '人工修改的镜头内容。')
    const provider = new StubTextProvider(async (_request, validate) => {
      stories.applyStory('episode-1', concurrentStory)
      return validate(story('模型版'))
    })
    const service = new StoryGenerationService(stories)

    await assert.rejects(
      service.generate(
        input({ title: '模型版', expectedRevisionId: revisionId }),
        execution(provider),
      ),
      (error: unknown) => error instanceof StoryGenerationError
        && error.code === 'STORY_REVISION_CONFLICT',
    )

    assert.deepEqual(stories.getStory('episode-1'), concurrentStory)
  } finally {
    database.close()
  }
})

test('a recovered ambiguous text submission is never sent to the Provider again', async () => {
  const { database, stories } = fixture()
  try {
    let resolverCalls = 0
    const handler = createStoryGenerationJobHandler({
      stories,
      resolveProvider: async () => {
        resolverCalls += 1
        return new StubTextProvider(async (_request, validate) => validate(story('龙脉初醒')))
      },
    })
    const job: JobRecord<StoryGenerationJobInput> = {
      id: 'ambiguous-story-job',
      type: STORY_GENERATION_JOB_TYPE,
      status: 'running',
      projectId: 'project-1',
      providerId: 'custom-text',
      providerConfigRevision: 2,
      input: input({ expectedRevisionId: null }),
      providerState: {
        operation: STORY_GENERATION_JOB_TYPE,
        phase: 'submitting',
        providerSupportsIdempotency: false,
      },
    }
    const context: JobHandlerContext = {
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
      waitingForProvider: async () => undefined,
    }
    await assert.rejects(
      handler(job, context),
      (error: unknown) => error instanceof StoryGenerationError
        && error.code === 'STORY_SUBMISSION_OUTCOME_UNKNOWN'
        && error.retryable === false,
    )
    assert.equal(resolverCalls, 0)
    assert.equal(stories.getStory('episode-1'), undefined)
  } finally {
    database.close()
  }
})
