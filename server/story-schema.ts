import type { JsonObject } from './types.js'

export type DialogueKind = 'dialogue' | 'narration'

export interface StoryDialogueLine {
  id: string
  sequence: number
  kind: DialogueKind
  speaker: string
  text: string
}

export interface StoryShot {
  id: string
  sequence: number
  code: string
  title: string
  description: string
  framing: string
  movement: string
  transition: string
  durationSeconds: number
  visualPrompt: string
  dialogueLines: StoryDialogueLine[]
}

export interface StoryScene {
  id: string
  sequence: number
  title: string
  locationId: string
  timeOfDay: string
  description: string
  shots: StoryShot[]
}

export type StoryCharacterVoiceSelectionSource = 'manual' | 'agentic'
export type StoryCharacterVoiceType = 'system' | 'voice_cloning' | 'voice_generation'
export type StoryCharacterVoiceEmotion =
  | 'happy'
  | 'sad'
  | 'angry'
  | 'fearful'
  | 'disgusted'
  | 'surprised'
  | 'calm'
  | 'fluent'
  | 'whisper'

export interface StoryCharacterVoiceDelivery {
  emotion: StoryCharacterVoiceEmotion
  speed: number
  pitch: number
}

/**
 * Server-authored, auditable casting snapshot. Provider credentials are never
 * part of this document; the immutable provider revision points to Keychain.
 */
export interface StoryCharacterVoiceProfile {
  version: 1
  voiceId: string
  providerId: string
  providerConfigRevision: number
  voiceType: StoryCharacterVoiceType
  voiceName: string
  descriptions: string[]
  selectionSource: StoryCharacterVoiceSelectionSource
  selectionRationale?: string
  profileTags?: string[]
  defaultDelivery?: StoryCharacterVoiceDelivery
  sceneDirections?: Array<StoryCharacterVoiceDelivery & {
    sceneId: string
    rationale: string
  }>
  recommendationJobId?: string
  catalogFingerprint: string
  catalogObservedAt: string
  historicalPin: boolean
  updatedAt: string
}

export interface StoryCharacter {
  id: string
  name: string
  role: string
  storyDescription: string
  visualDescription: string
  voiceProfile?: StoryCharacterVoiceProfile
}

export interface StoryLocation {
  id: string
  name: string
  storyDescription: string
  visualDescription: string
}

export interface StoryProp {
  id: string
  name: string
  description: string
  visualDescription: string
}

export interface StoryDocument {
  version: 1
  title: string
  targetDurationSeconds: number
  bible: {
    logline: string
    theme: string
    tone: string
    visualStyle: string
  }
  characters: StoryCharacter[]
  locations: StoryLocation[]
  props: StoryProp[]
  scenes: StoryScene[]
}

export class StoryValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`剧本结构校验失败：${issues.slice(0, 5).join('；')}`)
    this.name = 'StoryValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(
  value: unknown,
  path: string,
  issues: string[],
  options: { min?: number; max?: number; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    issues.push(`${path} 必须是文本`)
    return ''
  }
  const normalized = value.trim()
  const min = options.allowEmpty ? 0 : options.min ?? 1
  if (normalized.length < min) issues.push(`${path} 不能为空`)
  if (normalized.length > (options.max ?? 4_000)) issues.push(`${path} 过长`)
  return normalized
}

function number(
  value: unknown,
  path: string,
  issues: string[],
  min: number,
  max: number,
  integer = false,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    || (integer && !Number.isInteger(value))) {
    issues.push(`${path} 必须介于 ${min} 和 ${max} 之间${integer ? '且为整数' : ''}`)
    return min
  }
  return value
}

function record(value: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象`)
    return {}
  }
  return value
}

function array(value: unknown, path: string, issues: string[]): unknown[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须是数组`)
    return []
  }
  return value
}

function identifier(value: unknown, path: string, issues: string[]): string {
  const id = text(value, path, issues, { max: 100 })
  if (id && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) issues.push(`${path} 只能使用字母、数字、点、下划线和连字符`)
  return id
}

function uniqueIds(values: Array<{ id: string }>, path: string, issues: string[]): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.id)) issues.push(`${path} 存在重复 ID: ${value.id}`)
    seen.add(value.id)
  }
}

function parseDialogueLine(value: unknown, path: string, issues: string[]): StoryDialogueLine {
  const source = record(value, path, issues)
  const kind = source.kind === 'dialogue' || source.kind === 'narration' ? source.kind : 'dialogue'
  if (source.kind !== 'dialogue' && source.kind !== 'narration') issues.push(`${path}.kind 必须是 dialogue 或 narration`)
  return {
    id: identifier(source.id, `${path}.id`, issues),
    sequence: number(source.sequence, `${path}.sequence`, issues, 0, 100, true),
    kind,
    speaker: text(source.speaker, `${path}.speaker`, issues, { allowEmpty: kind === 'narration', max: 100 }),
    text: text(source.text, `${path}.text`, issues, { max: 1_000 }),
  }
}

function parseShot(value: unknown, path: string, issues: string[]): StoryShot {
  const source = record(value, path, issues)
  const dialogueLines = array(source.dialogueLines, `${path}.dialogueLines`, issues)
    .map((line, index) => parseDialogueLine(line, `${path}.dialogueLines[${index}]`, issues))
  uniqueIds(dialogueLines, `${path}.dialogueLines`, issues)
  dialogueLines.forEach((line, index) => {
    if (line.sequence !== index) issues.push(`${path}.dialogueLines[${index}].sequence 必须连续且从 0 开始`)
  })
  return {
    id: identifier(source.id, `${path}.id`, issues),
    sequence: number(source.sequence, `${path}.sequence`, issues, 0, 100, true),
    code: text(source.code, `${path}.code`, issues, { max: 40 }),
    title: text(source.title, `${path}.title`, issues, { max: 200 }),
    description: text(source.description, `${path}.description`, issues, { max: 2_000 }),
    framing: text(source.framing, `${path}.framing`, issues, { max: 100 }),
    movement: text(source.movement, `${path}.movement`, issues, { max: 100 }),
    transition: text(source.transition, `${path}.transition`, issues, { max: 100 }),
    durationSeconds: number(source.durationSeconds, `${path}.durationSeconds`, issues, 0.5, 15),
    visualPrompt: text(source.visualPrompt, `${path}.visualPrompt`, issues, { max: 4_000 }),
    dialogueLines,
  }
}

function parseScene(value: unknown, path: string, issues: string[]): StoryScene {
  const source = record(value, path, issues)
  const shots = array(source.shots, `${path}.shots`, issues)
    .map((shot, index) => parseShot(shot, `${path}.shots[${index}]`, issues))
  uniqueIds(shots, `${path}.shots`, issues)
  shots.forEach((shot, index) => {
    if (shot.sequence !== index) issues.push(`${path}.shots[${index}].sequence 必须连续且从 0 开始`)
  })
  return {
    id: identifier(source.id, `${path}.id`, issues),
    sequence: number(source.sequence, `${path}.sequence`, issues, 0, 10, true),
    title: text(source.title, `${path}.title`, issues, { max: 200 }),
    locationId: identifier(source.locationId, `${path}.locationId`, issues),
    timeOfDay: text(source.timeOfDay, `${path}.timeOfDay`, issues, { max: 100 }),
    description: text(source.description, `${path}.description`, issues, { max: 2_000 }),
    shots,
  }
}

function parseCharacter(value: unknown, path: string, issues: string[]): StoryCharacter {
  const source = record(value, path, issues)
  return {
    id: identifier(source.id, `${path}.id`, issues),
    name: text(source.name, `${path}.name`, issues, { max: 100 }),
    role: text(source.role, `${path}.role`, issues, { max: 100 }),
    storyDescription: text(source.storyDescription, `${path}.storyDescription`, issues, { max: 2_000 }),
    visualDescription: text(source.visualDescription, `${path}.visualDescription`, issues, { max: 2_000 }),
    ...(source.voiceProfile === undefined
      ? {}
      : { voiceProfile: parseCharacterVoiceProfile(source.voiceProfile, `${path}.voiceProfile`, issues) }),
  }
}

const CHARACTER_VOICE_EMOTIONS = new Set<StoryCharacterVoiceEmotion>([
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
  'fluent',
  'whisper',
])

function timestamp(value: unknown, path: string, issues: string[]): string {
  const normalized = text(value, path, issues, { max: 64 })
  if (!Number.isFinite(Date.parse(normalized))) issues.push(`${path} 必须是有效时间`)
  return normalized
}

function exactVoiceText(
  value: unknown,
  path: string,
  issues: string[],
  maximum: number,
): string {
  const normalized = text(value, path, issues, { max: maximum })
  if (/[\u0000-\u001f\u007f]/.test(normalized)) issues.push(`${path} 包含非法控制字符`)
  return normalized
}

function parseVoiceDelivery(
  value: unknown,
  path: string,
  issues: string[],
): StoryCharacterVoiceDelivery {
  const source = record(value, path, issues)
  const emotion = typeof source.emotion === 'string'
    && CHARACTER_VOICE_EMOTIONS.has(source.emotion as StoryCharacterVoiceEmotion)
    ? source.emotion as StoryCharacterVoiceEmotion
    : 'calm'
  if (source.emotion !== emotion) issues.push(`${path}.emotion 无效`)
  const pitch = number(source.pitch, `${path}.pitch`, issues, -12, 12)
  if (!Number.isInteger(pitch)) issues.push(`${path}.pitch 必须为整数`)
  return {
    emotion,
    speed: number(source.speed, `${path}.speed`, issues, 0.5, 2),
    pitch,
  }
}

function parseCharacterVoiceProfile(
  value: unknown,
  path: string,
  issues: string[],
): StoryCharacterVoiceProfile {
  const source = record(value, path, issues)
  if (source.version !== 1) issues.push(`${path}.version 必须为 1`)
  const voiceType = source.voiceType === 'system'
    || source.voiceType === 'voice_cloning'
    || source.voiceType === 'voice_generation'
    ? source.voiceType
    : 'system'
  if (source.voiceType !== voiceType) issues.push(`${path}.voiceType 无效`)
  const selectionSource = source.selectionSource === 'manual' || source.selectionSource === 'agentic'
    ? source.selectionSource
    : 'manual'
  if (source.selectionSource !== selectionSource) issues.push(`${path}.selectionSource 无效`)
  const descriptions = array(source.descriptions, `${path}.descriptions`, issues)
  if (descriptions.length > 16) issues.push(`${path}.descriptions 最多 16 项`)
  const profileTags = source.profileTags === undefined
    ? undefined
    : array(source.profileTags, `${path}.profileTags`, issues)
        .map((tag, index) => exactVoiceText(tag, `${path}.profileTags[${index}]`, issues, 40))
  if (profileTags && profileTags.length > 8) issues.push(`${path}.profileTags 最多 8 项`)
  const sceneDirections = source.sceneDirections === undefined
    ? undefined
    : array(source.sceneDirections, `${path}.sceneDirections`, issues).map((item, index) => {
        const directionPath = `${path}.sceneDirections[${index}]`
        const direction = record(item, directionPath, issues)
        return {
          sceneId: identifier(direction.sceneId, `${directionPath}.sceneId`, issues),
          ...parseVoiceDelivery(direction, directionPath, issues),
          rationale: exactVoiceText(direction.rationale, `${directionPath}.rationale`, issues, 500),
        }
      })
  if (sceneDirections && sceneDirections.length > 20) issues.push(`${path}.sceneDirections 最多 20 项`)
  const catalogFingerprint = exactVoiceText(
    source.catalogFingerprint,
    `${path}.catalogFingerprint`,
    issues,
    64,
  )
  if (!/^[0-9a-f]{64}$/.test(catalogFingerprint)) {
    issues.push(`${path}.catalogFingerprint 必须是 SHA-256`)
  }
  return {
    version: 1,
    voiceId: exactVoiceText(source.voiceId, `${path}.voiceId`, issues, 256),
    providerId: identifier(source.providerId, `${path}.providerId`, issues),
    providerConfigRevision: number(
      source.providerConfigRevision,
      `${path}.providerConfigRevision`,
      issues,
      1,
      1_000_000_000,
      true,
    ),
    voiceType,
    voiceName: exactVoiceText(source.voiceName, `${path}.voiceName`, issues, 300),
    descriptions: descriptions.slice(0, 16).map((description, index) => (
      exactVoiceText(description, `${path}.descriptions[${index}]`, issues, 1_000)
    )),
    selectionSource,
    ...(source.selectionRationale === undefined
      ? {}
      : {
          selectionRationale: exactVoiceText(
            source.selectionRationale,
            `${path}.selectionRationale`,
            issues,
            1_000,
          ),
        }),
    ...(profileTags ? { profileTags: profileTags.slice(0, 8) } : {}),
    ...(source.defaultDelivery === undefined
      ? {}
      : { defaultDelivery: parseVoiceDelivery(source.defaultDelivery, `${path}.defaultDelivery`, issues) }),
    ...(sceneDirections ? { sceneDirections: sceneDirections.slice(0, 20) } : {}),
    ...(source.recommendationJobId === undefined
      ? {}
      : {
          recommendationJobId: identifier(
            source.recommendationJobId,
            `${path}.recommendationJobId`,
            issues,
          ),
        }),
    catalogFingerprint,
    catalogObservedAt: timestamp(source.catalogObservedAt, `${path}.catalogObservedAt`, issues),
    historicalPin: source.historicalPin === true,
    updatedAt: timestamp(source.updatedAt, `${path}.updatedAt`, issues),
  }
}

export function parseStoryCharacterVoiceProfile(value: unknown): StoryCharacterVoiceProfile {
  const issues: string[] = []
  const profile = parseCharacterVoiceProfile(value, '$', issues)
  if (issues.length) throw new StoryValidationError(issues)
  return profile
}

function parseLocation(value: unknown, path: string, issues: string[]): StoryLocation {
  const source = record(value, path, issues)
  return {
    id: identifier(source.id, `${path}.id`, issues),
    name: text(source.name, `${path}.name`, issues, { max: 100 }),
    storyDescription: text(source.storyDescription, `${path}.storyDescription`, issues, { max: 2_000 }),
    visualDescription: text(source.visualDescription, `${path}.visualDescription`, issues, { max: 2_000 }),
  }
}

function parseProp(value: unknown, path: string, issues: string[]): StoryProp {
  const source = record(value, path, issues)
  return {
    id: identifier(source.id, `${path}.id`, issues),
    name: text(source.name, `${path}.name`, issues, { max: 100 }),
    description: text(source.description, `${path}.description`, issues, { max: 2_000 }),
    visualDescription: text(source.visualDescription, `${path}.visualDescription`, issues, { max: 2_000 }),
  }
}

export function parseStoryDocument(value: unknown): StoryDocument {
  const issues: string[] = []
  const source = record(value, '$', issues)
  if (source.version !== 1) issues.push('$.version 必须为 1')
  const bibleSource = record(source.bible, '$.bible', issues)
  const characters = array(source.characters, '$.characters', issues)
    .map((item, index) => parseCharacter(item, `$.characters[${index}]`, issues))
  const locations = array(source.locations, '$.locations', issues)
    .map((item, index) => parseLocation(item, `$.locations[${index}]`, issues))
  const props = array(source.props, '$.props', issues)
    .map((item, index) => parseProp(item, `$.props[${index}]`, issues))
  const scenes = array(source.scenes, '$.scenes', issues)
    .map((item, index) => parseScene(item, `$.scenes[${index}]`, issues))

  uniqueIds(characters, '$.characters', issues)
  uniqueIds(locations, '$.locations', issues)
  uniqueIds(props, '$.props', issues)
  uniqueIds(scenes, '$.scenes', issues)
  scenes.forEach((scene, index) => {
    if (scene.sequence !== index) issues.push(`$.scenes[${index}].sequence 必须连续且从 0 开始`)
  })
  if (scenes.length < 1 || scenes.length > 2) issues.push('$.scenes 必须包含 1 到 2 场')
  const shots = scenes.flatMap((scene) => scene.shots)
  if (shots.length < 6 || shots.length > 12) issues.push('剧本必须包含 6 到 12 个镜头')
  const duration = shots.reduce((total, shot) => total + shot.durationSeconds, 0)
  if (duration < 30 || duration > 60) issues.push(`镜头总时长必须为 30 到 60 秒，当前为 ${duration.toFixed(1)} 秒`)
  const locationIds = new Set(locations.map((location) => location.id))
  for (const scene of scenes) {
    if (!locationIds.has(scene.locationId)) issues.push(`场景 ${scene.id} 引用了不存在的地点 ${scene.locationId}`)
  }

  const targetDurationSeconds = number(source.targetDurationSeconds, '$.targetDurationSeconds', issues, 30, 60)
  if (Math.abs(targetDurationSeconds - duration) > 3) {
    issues.push(`目标时长与镜头总时长相差不能超过 3 秒`)
  }
  const document: StoryDocument = {
    version: 1,
    title: text(source.title, '$.title', issues, { max: 200 }),
    targetDurationSeconds,
    bible: {
      logline: text(bibleSource.logline, '$.bible.logline', issues, { max: 500 }),
      theme: text(bibleSource.theme, '$.bible.theme', issues, { max: 500 }),
      tone: text(bibleSource.tone, '$.bible.tone', issues, { max: 500 }),
      visualStyle: text(bibleSource.visualStyle, '$.bible.visualStyle', issues, { max: 1_000 }),
    },
    characters,
    locations,
    props,
    scenes,
  }
  if (issues.length) throw new StoryValidationError(issues)
  return document
}

const stringField = (description: string): JsonObject => ({ type: 'string', minLength: 1, description })
const idField = (description: string): JsonObject => ({
  ...stringField(description),
  pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
})

export const STORY_DOCUMENT_JSON_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'title', 'targetDurationSeconds', 'bible', 'characters', 'locations', 'props', 'scenes'],
  properties: {
    version: { type: 'integer', const: 1 },
    title: stringField('漫剧片名'),
    targetDurationSeconds: { type: 'number', minimum: 30, maximum: 60 },
    bible: {
      type: 'object',
      additionalProperties: false,
      required: ['logline', 'theme', 'tone', 'visualStyle'],
      properties: {
        logline: stringField('一句话故事'),
        theme: stringField('主题'),
        tone: stringField('基调'),
        visualStyle: stringField('统一视觉风格'),
      },
    },
    characters: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name', 'role', 'storyDescription', 'visualDescription'],
        properties: {
          id: idField('角色 ID'), name: stringField('姓名'), role: stringField('角色职能'),
          storyDescription: stringField('故事设定'), visualDescription: stringField('可绘制的固定外观'),
        },
      },
    },
    locations: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name', 'storyDescription', 'visualDescription'],
        properties: {
          id: idField('地点 ID'), name: stringField('地点名'),
          storyDescription: stringField('地点故事设定'), visualDescription: stringField('地点视觉设定'),
        },
      },
    },
    props: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name', 'description', 'visualDescription'],
        properties: {
          id: idField('道具 ID'), name: stringField('道具名'), description: stringField('剧情用途'),
          visualDescription: stringField('道具视觉设定'),
        },
      },
    },
    scenes: {
      type: 'array', minItems: 1, maxItems: 2,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'sequence', 'title', 'locationId', 'timeOfDay', 'description', 'shots'],
        properties: {
          id: idField('场次 ID'), sequence: { type: 'integer', minimum: 0 }, title: stringField('场次名'),
          locationId: idField('已定义的地点 ID'), timeOfDay: stringField('时间'), description: stringField('场次描述'),
          shots: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', additionalProperties: false,
              required: ['id', 'sequence', 'code', 'title', 'description', 'framing', 'movement', 'transition', 'durationSeconds', 'visualPrompt', 'dialogueLines'],
              properties: {
                id: idField('镜头 ID'), sequence: { type: 'integer', minimum: 0 }, code: stringField('镜号'), title: stringField('镜头名'),
                description: stringField('画面与动作'), framing: stringField('景别'), movement: stringField('运镜'),
                transition: stringField('转场'), durationSeconds: { type: 'number', minimum: 0.5, maximum: 15 },
                visualPrompt: stringField('可直接用于图片/视频的提示词'),
                dialogueLines: {
                  type: 'array',
                  items: {
                    type: 'object', additionalProperties: false,
                    required: ['id', 'sequence', 'kind', 'speaker', 'text'],
                    properties: {
                      id: idField('台词 ID'), sequence: { type: 'integer', minimum: 0 },
                      kind: { type: 'string', enum: ['dialogue', 'narration'] }, speaker: { type: 'string' }, text: stringField('台词或旁白'),
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
}
