import type {
  SeedanceAspectRatio,
  SeedanceImageRole,
  SeedanceResolution,
} from './providers/seedance.js'

export const VIDEO_GENERATION_SPEC_VERSION = 1 as const
export const VIDEO_PROMPT_COMPILER_VERSION = 'seedance-compact-v1' as const
export const VIDEO_PROMPT_COMPILER_VERSIONS = [
  VIDEO_PROMPT_COMPILER_VERSION,
  'seedance-verbose-baseline-v1',
] as const
export const VIDEO_AUDIO_POLICIES = ['sfx_only', 'silent', 'provider_audio'] as const
export const MAX_COMPILED_VIDEO_PROMPT_LENGTH = 1_200

const MAX_SUBJECTS = 8
const MAX_SUBJECT_NAME_LENGTH = 80
const MAX_SCENE_LENGTH = 240
const MAX_ACTION_LENGTH = 640
const MAX_SHOT_LANGUAGE_LENGTH = 120

export type VideoAudioPolicy = (typeof VIDEO_AUDIO_POLICIES)[number]
export type VideoPromptCompilerVersion = (typeof VIDEO_PROMPT_COMPILER_VERSIONS)[number]

export interface VideoGenerationReferenceSpec {
  assetId: string
  role: SeedanceImageRole
}

export interface VideoGenerationAudioLineSpec {
  kind: 'dialogue' | 'narration'
  speaker: string
  text: string
}

/**
 * Provider-neutral, immutable direction fixed before a paid video job exists.
 * Reference checksums stay in the job binding; this compact projection makes
 * the creative request and compiler version inspectable without duplicating
 * secrets, URLs, or binary media.
 */
export interface VideoGenerationSpec {
  version: typeof VIDEO_GENERATION_SPEC_VERSION
  promptCompilerVersion: VideoPromptCompilerVersion
  subjectNames: string[]
  scene: string
  action: string
  shotSize: string
  cameraMovement: string
  audioPolicy: VideoAudioPolicy
  /** Exact current-Story script supplied only when the Provider owns speech. */
  audioLines?: VideoGenerationAudioLineSpec[]
  durationSeconds: number
  resolution: SeedanceResolution
  aspectRatio: SeedanceAspectRatio
  sourceRevisionId: string
  references: VideoGenerationReferenceSpec[]
}

export interface CompileVideoPromptResult {
  prompt: string
  notices: string[]
}

export interface CreateVideoGenerationSpecInput {
  promptCompilerVersion?: VideoPromptCompilerVersion
  subjectNames?: readonly string[]
  scene?: string
  action: string
  shotSize?: string
  cameraMovement?: string
  audioPolicy: VideoAudioPolicy
  audioLines?: readonly VideoGenerationAudioLineSpec[]
  durationSeconds: number
  resolution: SeedanceResolution
  aspectRatio: SeedanceAspectRatio
  sourceRevisionId: string
  references?: readonly VideoGenerationReferenceSpec[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function compactWhitespace(value: string): string {
  return value.replace(/[\t\r\n ]+/g, ' ').trim()
}

/** Remove only explicit time-range annotations; narrative numbers remain. */
export function removeVideoPromptTimecodes(value: string): string {
  return compactWhitespace(value
    .replace(
      /[\[【(（]\s*\d{1,2}(?::\d{2})?\s*(?:秒|s)?\s*[-–—~至到]\s*\d{1,2}(?::\d{2})?\s*(?:秒|s)?\s*[\]】)）]\s*[:：]?/giu,
      ' ',
    )
    .replace(
      /(^|[。；;]\s*)\d{1,2}\s*[-–—~至到]\s*\d{1,2}\s*秒\s*[:：]/gu,
      '$1',
    ))
}

function boundedText(
  value: string,
  maximum: number,
  label: string,
  notices: string[],
): string {
  const normalized = removeVideoPromptTimecodes(value)
  if (normalized.length <= maximum) return normalized
  notices.push(`${label}已压缩到 ${maximum} 字，避免生成冗长 Prompt`)
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`
}

function normalizedSubjects(values: readonly string[], notices: string[]): string[] {
  const subjects: string[] = []
  for (const value of values) {
    const subject = compactWhitespace(value).slice(0, MAX_SUBJECT_NAME_LENGTH)
    if (!subject || subjects.includes(subject)) continue
    subjects.push(subject)
    if (subjects.length === MAX_SUBJECTS) {
      if (values.length > MAX_SUBJECTS) notices.push(`主体已限制为前 ${MAX_SUBJECTS} 个明确角色`)
      break
    }
  }
  return subjects
}

function sentence(value: string): string {
  if (!value) return ''
  return /[。！？.!?]$/u.test(value) ? value : `${value}。`
}

function normalizedAudioLines(
  values: readonly VideoGenerationAudioLineSpec[],
): VideoGenerationAudioLineSpec[] {
  if (values.length > 8) throw new TypeError('Video generation audioLines exceeds 8 lines')
  return values.map((line) => {
    if (!line || (line.kind !== 'dialogue' && line.kind !== 'narration')) {
      throw new TypeError('Video generation audio line kind is invalid')
    }
    const speaker = compactWhitespace(line.speaker).slice(0, 80)
    const text = compactWhitespace(line.text).slice(0, 500)
    if (!speaker || !text) throw new TypeError('Video generation audio line is empty')
    return { kind: line.kind, speaker, text }
  })
}

function audioInstruction(
  policy: VideoAudioPolicy,
  rawAudioLines: readonly VideoGenerationAudioLineSpec[] = [],
): string {
  switch (policy) {
    case 'sfx_only':
      return '声音：仅生成与画面同步的环境音和动作音，不生成背景音乐，不生成旁白或额外对白。'
    case 'silent':
      return '声音：静音，不生成环境音、背景音乐、旁白或对白。'
    case 'provider_audio': {
      const audioLines = normalizedAudioLines(rawAudioLines)
      if (audioLines.length === 0) return '声音：生成与画面匹配的模型音频。'
      const script = audioLines.map((line) => (
        `${line.kind === 'narration' ? '旁白' : `角色${line.speaker}`}说：“${line.text}”`
      )).join('；')
      return `声音：由模型同步生成与画面匹配的环境音和人声。${script}。上述台词必须逐字准确，保留停顿与语气；不生成背景音乐、额外旁白或额外对白。`
    }
  }
}

export function isVideoAudioPolicy(value: unknown): value is VideoAudioPolicy {
  return typeof value === 'string' && VIDEO_AUDIO_POLICIES.includes(value as VideoAudioPolicy)
}

export function isVideoPromptCompilerVersion(value: unknown): value is VideoPromptCompilerVersion {
  return typeof value === 'string'
    && VIDEO_PROMPT_COMPILER_VERSIONS.includes(value as VideoPromptCompilerVersion)
}

export function videoAudioPolicyGeneratesAudio(policy: VideoAudioPolicy): boolean {
  return policy !== 'silent'
}

export function createVideoGenerationSpec(
  input: CreateVideoGenerationSpecInput,
): VideoGenerationSpec {
  const notices: string[] = []
  const action = removeVideoPromptTimecodes(input.action)
  if (!action) throw new TypeError('Video generation action must not be empty')
  const sourceRevisionId = compactWhitespace(input.sourceRevisionId)
  if (!sourceRevisionId) throw new TypeError('Video generation sourceRevisionId must not be empty')
  if (!Number.isInteger(input.durationSeconds)
    || input.durationSeconds < 4
    || input.durationSeconds > 15) {
    throw new TypeError('Video generation durationSeconds must be an integer from 4 through 15')
  }
  if (!isVideoAudioPolicy(input.audioPolicy)) {
    throw new TypeError('Video generation audioPolicy is invalid')
  }
  const promptCompilerVersion = input.promptCompilerVersion ?? VIDEO_PROMPT_COMPILER_VERSION
  if (!isVideoPromptCompilerVersion(promptCompilerVersion)) {
    throw new TypeError('Video generation promptCompilerVersion is invalid')
  }
  const audioLines = input.audioPolicy === 'provider_audio'
    ? normalizedAudioLines(input.audioLines ?? [])
    : []
  return {
    version: VIDEO_GENERATION_SPEC_VERSION,
    promptCompilerVersion,
    subjectNames: normalizedSubjects(input.subjectNames ?? [], notices),
    scene: removeVideoPromptTimecodes(input.scene ?? ''),
    action,
    shotSize: removeVideoPromptTimecodes(input.shotSize ?? ''),
    cameraMovement: removeVideoPromptTimecodes(input.cameraMovement ?? ''),
    audioPolicy: input.audioPolicy,
    ...(audioLines.length ? { audioLines } : {}),
    durationSeconds: input.durationSeconds,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
    sourceRevisionId,
    references: (input.references ?? []).map((reference) => ({
      assetId: compactWhitespace(reference.assetId),
      role: reference.role,
    })),
  }
}

export function compileVideoGenerationPrompt(
  spec: VideoGenerationSpec,
): CompileVideoPromptResult {
  if (!isVideoGenerationSpec(spec)) throw new TypeError('Video generation spec is invalid')
  const notices: string[] = []
  const subjectNames = normalizedSubjects(spec.subjectNames, notices)
  const scene = boundedText(spec.scene, MAX_SCENE_LENGTH, '场景', notices)
  const action = boundedText(spec.action, MAX_ACTION_LENGTH, '主要动作', notices)
  const shotSize = boundedText(spec.shotSize, MAX_SHOT_LANGUAGE_LENGTH, '景别', notices)
  const movement = boundedText(
    spec.cameraMovement,
    MAX_SHOT_LANGUAGE_LENGTH,
    '运镜',
    notices,
  )
  const lines: string[] = spec.promptCompilerVersion === 'seedance-verbose-baseline-v1'
    ? [
        `任务：生成一条 ${spec.durationSeconds} 秒、${spec.aspectRatio}、${spec.resolution} 的单镜头连续视频。`,
        ...(subjectNames.length > 0
          ? [`主体设定：${subjectNames.join('、')}。${spec.references.length ? '角色身份、面貌、发型、服饰与道具必须以已选择的参考图为准。' : '保持主体身份与外观前后一致。'}`]
          : spec.references.length > 0
            ? ['主体设定：使用已选择的参考图保持主体身份、外观与构图一致。']
            : []),
        ...(scene ? [`场景设定：${sentence(scene)}`] : []),
        ...(shotSize ? [`构图与景别：${sentence(shotSize)}`] : []),
        ...(movement ? [`镜头运动：${sentence(movement)}`] : []),
        `主要动作：${sentence(action)}`,
        '连续性要求：动作在单镜头内自然衔接，主体比例、空间关系、光线方向和画面风格保持稳定，不新增未描述的主要角色或关键道具。',
        audioInstruction(spec.audioPolicy, spec.audioLines),
      ]
    : (() => {
        const compactLines: string[] = []
        if (subjectNames.length > 0) {
          compactLines.push(`主体：${subjectNames.join('、')}。${spec.references.length ? '外观以已选择的参考图为准。' : ''}`)
        } else if (spec.references.length > 0) {
          compactLines.push('主体：使用已选择的参考图保持主体与构图一致。')
        }
        if (scene) compactLines.push(`场景：${sentence(scene)}`)
        const camera = [shotSize, movement].filter(Boolean).join('，')
        compactLines.push(`镜头：${camera ? `${camera}。` : ''}${sentence(action)}`)
        compactLines.push(audioInstruction(spec.audioPolicy, spec.audioLines))
        return compactLines
      })()
  let prompt = lines.join('\n')
  if (prompt.length > MAX_COMPILED_VIDEO_PROMPT_LENGTH) {
    notices.push(`最终 Prompt 已压缩到 ${MAX_COMPILED_VIDEO_PROMPT_LENGTH} 字`)
    prompt = `${prompt.slice(0, MAX_COMPILED_VIDEO_PROMPT_LENGTH - 1).trimEnd()}…`
  }
  return { prompt, notices }
}

export function isVideoGenerationSpec(value: unknown): value is VideoGenerationSpec {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'version',
    'promptCompilerVersion',
    'subjectNames',
    'scene',
    'action',
    'shotSize',
    'cameraMovement',
    'audioPolicy',
    'audioLines',
    'durationSeconds',
    'resolution',
    'aspectRatio',
    'sourceRevisionId',
    'references',
  ])) return false
  if (value.version !== VIDEO_GENERATION_SPEC_VERSION
    || !isVideoPromptCompilerVersion(value.promptCompilerVersion)
    || !Array.isArray(value.subjectNames)
    || value.subjectNames.some((item) => typeof item !== 'string' || !item.trim())
    || value.subjectNames.length > MAX_SUBJECTS
    || value.subjectNames.some((item) => (item as string).length > MAX_SUBJECT_NAME_LENGTH)
    || typeof value.scene !== 'string'
    || value.scene.length > 2_000
    || typeof value.action !== 'string'
    || !value.action.trim()
    || value.action.length > 4_000
    || typeof value.shotSize !== 'string'
    || value.shotSize.length > 500
    || typeof value.cameraMovement !== 'string'
    || value.cameraMovement.length > 500
    || !isVideoAudioPolicy(value.audioPolicy)
    || (value.audioLines !== undefined
      && (!Array.isArray(value.audioLines)
        || value.audioLines.length > 8
        || value.audioLines.some((line) => !isRecord(line)
          || !hasOnlyKeys(line, ['kind', 'speaker', 'text'])
          || (line.kind !== 'dialogue' && line.kind !== 'narration')
          || typeof line.speaker !== 'string'
          || !line.speaker.trim()
          || line.speaker.length > 80
          || typeof line.text !== 'string'
          || !line.text.trim()
          || line.text.length > 500)))
    || (value.audioLines !== undefined && value.audioPolicy !== 'provider_audio')
    || !Number.isInteger(value.durationSeconds)
    || (value.durationSeconds as number) < 4
    || (value.durationSeconds as number) > 15
    || !['480p', '720p', '1080p'].includes(String(value.resolution))
    || !['16:9', '9:16', '1:1'].includes(String(value.aspectRatio))
    || typeof value.sourceRevisionId !== 'string'
    || !value.sourceRevisionId.trim()
    || !Array.isArray(value.references)
    || value.references.length > 9) return false
  return value.references.every((reference) => isRecord(reference)
    && hasOnlyKeys(reference, ['assetId', 'role'])
    && typeof reference.assetId === 'string'
    && Boolean(reference.assetId.trim())
    && ['first_frame', 'last_frame', 'reference_image'].includes(String(reference.role)))
}
