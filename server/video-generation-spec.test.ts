import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileVideoGenerationPrompt,
  createVideoGenerationSpec,
  isVideoGenerationSpec,
  MAX_COMPILED_VIDEO_PROMPT_LENGTH,
  removeVideoPromptTimecodes,
  videoAudioPolicyGeneratesAudio,
} from './video-generation-spec.js'

function spec(overrides: Partial<Parameters<typeof createVideoGenerationSpec>[0]> = {}) {
  return createVideoGenerationSpec({
    subjectNames: ['阿离', '阿离'],
    scene: '秦岭断崖，暮春黄昏',
    action: '[0-3秒] 远处长安第一盏灯亮起，阿离站在断崖边，冷雾缓慢涌动。',
    shotSize: '远景',
    cameraMovement: '固定镜头',
    audioPolicy: 'sfx_only',
    durationSeconds: 5,
    resolution: '720p',
    aspectRatio: '16:9',
    sourceRevisionId: 'revision-1',
    references: [
      { assetId: 'character-ali-v2', role: 'reference_image' },
      { assetId: 'location-cliff-v1', role: 'reference_image' },
    ],
    ...overrides,
  })
}

test('compact compiler gives reference media and text separate responsibilities', () => {
  const result = compileVideoGenerationPrompt(spec())
  assert.equal(result.prompt, [
    '主体：阿离。外观以已选择的参考图为准。',
    '场景：秦岭断崖，暮春黄昏。',
    '镜头：远景，固定镜头。远处长安第一盏灯亮起，阿离站在断崖边，冷雾缓慢涌动。',
    '声音：仅生成与画面同步的环境音和动作音，不生成背景音乐，不生成旁白或额外对白。',
  ].join('\n'))
  assert.doesNotMatch(result.prompt, /0-3秒/)
  assert.ok(result.prompt.length < MAX_COMPILED_VIDEO_PROMPT_LENGTH)
})

test('verbose baseline changes only the prompt strategy and remains deterministic', () => {
  const compactSpec = spec()
  const baselineSpec = spec({ promptCompilerVersion: 'seedance-verbose-baseline-v1' })
  const compact = compileVideoGenerationPrompt(compactSpec)
  const baseline = compileVideoGenerationPrompt(baselineSpec)

  assert.equal(baselineSpec.promptCompilerVersion, 'seedance-verbose-baseline-v1')
  assert.deepEqual(
    { ...baselineSpec, promptCompilerVersion: compactSpec.promptCompilerVersion },
    compactSpec,
  )
  assert.notEqual(baseline.prompt, compact.prompt)
  assert.ok(baseline.prompt.length > compact.prompt.length)
  assert.match(baseline.prompt, /连续性要求/)
  assert.match(baseline.prompt, /5 秒、16:9、720p/)
  assert.doesNotMatch(baseline.prompt, /0-3秒/)
  assert.equal(compileVideoGenerationPrompt(baselineSpec).prompt, baseline.prompt)
  assert.ok(baseline.prompt.length <= MAX_COMPILED_VIDEO_PROMPT_LENGTH)
})

test('timecode removal keeps narrative numbers intact', () => {
  assert.equal(
    removeVideoPromptTimecodes('【00:00-00:03】第一盏灯亮起；十年后她仍在等待。'),
    '第一盏灯亮起；十年后她仍在等待。',
  )
})

test('audio policy maps to provider audio without pretending every mode is SFX-only', () => {
  assert.equal(videoAudioPolicyGeneratesAudio('sfx_only'), true)
  assert.equal(videoAudioPolicyGeneratesAudio('provider_audio'), true)
  assert.equal(videoAudioPolicyGeneratesAudio('silent'), false)
  assert.match(
    compileVideoGenerationPrompt(spec({ audioPolicy: 'silent' })).prompt,
    /声音：静音/,
  )
  assert.doesNotMatch(
    compileVideoGenerationPrompt(spec({ audioPolicy: 'provider_audio' })).prompt,
    /不生成背景音乐/,
  )
})

test('provider audio binds the exact Story dialogue and forbids invented speech', () => {
  const value = spec({
    audioPolicy: 'provider_audio',
    audioLines: [{ kind: 'dialogue', speaker: '阿离', text: '不可能……十年了。' }],
    durationSeconds: 4,
    resolution: '1080p',
  })
  const { prompt } = compileVideoGenerationPrompt(value)
  assert.match(prompt, /角色阿离说：“不可能……十年了。”/)
  assert.match(prompt, /逐字准确/)
  assert.match(prompt, /不生成背景音乐、额外旁白或额外对白/)
})

test('spec is strict, immutable request metadata rather than an arbitrary prompt object', () => {
  const value = spec()
  assert.equal(isVideoGenerationSpec(value), true)
  assert.equal(isVideoGenerationSpec({ ...value, unknown: true }), false)
  assert.equal(isVideoGenerationSpec({ ...value, durationSeconds: 3 }), false)
  assert.equal(isVideoGenerationSpec({ ...value, promptCompilerVersion: 'arbitrary' }), false)
})

test('compiler bounds verbose shot prose deterministically', () => {
  const result = compileVideoGenerationPrompt(spec({ action: '云海翻涌。'.repeat(300) }))
  assert.ok(result.prompt.length <= MAX_COMPILED_VIDEO_PROMPT_LENGTH)
  assert.ok(result.notices.some((notice) => notice.includes('主要动作已压缩')))
})
