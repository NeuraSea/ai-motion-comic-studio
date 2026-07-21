import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileLinePerformance,
  LINE_PERFORMANCE_RECOMMENDATION_SCHEMA,
  LINE_PERFORMANCE_RECOMMENDATION_VERSION,
  LinePerformanceError,
  parseLinePerformanceRecommendation,
  recommendLinePerformance,
  stripLinePerformanceMarkers,
  type LinePerformanceRecommendationContext,
} from './line-performance.js'
import type { StructuredGenerationInput, TextProvider } from './providers/text.js'

const text = '不可能……十年了'

function context(): LinePerformanceRecommendationContext {
  return {
    projectId: 'project-1',
    episodeId: 'episode-1',
    databaseLineId: 'line-db-1',
    lineId: 'line-1',
    sourceRevisionId: 'story-r1',
    lineKind: 'dialogue',
    originalText: text,
    performer: {
      scope: 'character',
      voiceProfileRevisionId: 'voice-r1',
      name: '阿离',
      role: '主角',
      storyDescription: '她寻找失踪十年的师父。',
      voiceDescription: '年轻、克制。',
    },
    scene: {
      id: 'scene-1',
      title: '旧宅重逢',
      timeOfDay: '夜',
      description: '阿离认出眼前的人。',
      shotDescription: '镜头缓慢推近。',
    },
    contextLines: [{
      relation: 'previous',
      kind: 'dialogue',
      speaker: '师父',
      text: '你长大了。',
    }],
  }
}

function rawRecommendation(overrides: Record<string, unknown> = {}) {
  return {
    version: LINE_PERFORMANCE_RECOMMENDATION_VERSION,
    lineId: 'line-1',
    emotion: 'surprised',
    speed: 0.82,
    pitch: 1,
    openingSoundTag: '(gasps)',
    pausePlan: [{ afterCharacter: 5, durationSeconds: 0.8 }],
    rationale: '先震惊吸气，再用长停顿表现十年重逢的难以置信。',
    ...overrides,
  }
}

test('AI direction compiles a dramatic pause while preserving the original line character-for-character', () => {
  const recommendation = parseLinePerformanceRecommendation(rawRecommendation(), 'line-1', text)
  const annotated = compileLinePerformance(text, recommendation)
  assert.equal(annotated, '(gasps)不可能……<#0.80#>十年了')
  assert.equal(stripLinePerformanceMarkers(annotated), text)

  const tampered = annotated.replace('十年', '五年')
  assert.notEqual(stripLinePerformanceMarkers(tampered), text)
})

test('only the documented Speech 2.8 opening tags and seven emotions pass local validation', () => {
  assert.throws(
    () => parseLinePerformanceRecommendation(
      rawRecommendation({ openingSoundTag: '(crying)' }),
      'line-1',
      text,
    ),
    (error: unknown) => error instanceof LinePerformanceError
      && error.code === 'LINE_PERFORMANCE_OUTPUT_INVALID'
      && /openingSoundTag/.test(error.message),
  )
  assert.throws(
    () => parseLinePerformanceRecommendation(
      rawRecommendation({ emotion: 'whisper' }),
      'line-1',
      text,
    ),
    (error: unknown) => error instanceof LinePerformanceError
      && error.code === 'LINE_PERFORMANCE_OUTPUT_INVALID',
  )
  assert.throws(
    () => parseLinePerformanceRecommendation(
      rawRecommendation({ pitch: 0.5 }),
      'line-1',
      text,
    ),
    (error: unknown) => error instanceof LinePerformanceError
      && /整数/.test(error.message),
  )
})

test('pause boundaries, duration precision, line binding and extra fields fail closed', () => {
  for (const invalid of [
    rawRecommendation({ lineId: 'line-2' }),
    rawRecommendation({ pausePlan: [{ afterCharacter: 0, durationSeconds: 0.8 }] }),
    rawRecommendation({ pausePlan: [{ afterCharacter: 5, durationSeconds: 0.333 }] }),
    rawRecommendation({ pausePlan: [
      { afterCharacter: 5, durationSeconds: 0.8 },
      { afterCharacter: 3, durationSeconds: 0.2 },
    ] }),
    { ...rawRecommendation(), rewrittenText: '不可能，已经五年了' },
  ]) {
    assert.throws(
      () => parseLinePerformanceRecommendation(invalid, 'line-1', text),
      (error: unknown) => error instanceof LinePerformanceError
        && error.code === 'LINE_PERFORMANCE_OUTPUT_INVALID',
    )
  }
})

class StubTextProvider implements TextProvider {
  readonly name = 'stub'
  readonly model = 'text-model'
  readonly configured = true
  calls = 0
  request?: StructuredGenerationInput

  async listModels(): Promise<string[]> { return [this.model] }

  async generateStructured<T>(
    request: StructuredGenerationInput,
    validate: (value: unknown) => T,
  ): Promise<T> {
    this.calls += 1
    this.request = request
    const { version: _version, ...body } = rawRecommendation()
    return validate(body)
  }
}

test('AI director sends one bounded structured request without unsupported schema keywords or editable text output', async () => {
  const provider = new StubTextProvider()
  const result = await recommendLinePerformance(
    provider,
    context(),
    new AbortController().signal,
    'job-1',
  )
  assert.equal(provider.calls, 1)
  assert.equal(result.lineId, 'line-1')
  assert.equal(provider.request?.idempotencyKey, 'job-1')
  assert.equal(JSON.stringify(LINE_PERFORMANCE_RECOMMENDATION_SCHEMA).includes('uniqueItems'), false)
  assert.equal(JSON.stringify(provider.request?.schema).includes('uniqueItems'), false)
  assert.match(provider.request?.systemPrompt ?? '', /不得改写/)
  const schemaProperties = (provider.request?.schema.properties ?? {}) as Record<string, unknown>
  assert.equal('text' in schemaProperties, false)
  assert.equal('rewrittenText' in schemaProperties, false)
})
