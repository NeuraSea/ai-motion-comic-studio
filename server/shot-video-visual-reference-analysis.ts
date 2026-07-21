import { createHash } from 'node:crypto'

import type { TextProvider } from './providers/text.js'
import type { JsonObject } from './types.js'

export const SHOT_VIDEO_VISUAL_REFERENCE_ANALYSIS_VERSION = 'shot-video-vision-agent-v1' as const
export const SHOT_VIDEO_VISUAL_REFERENCE_CONFIDENCE_THRESHOLD = 0.68
export const SHOT_VIDEO_VISUAL_REFERENCE_MAX_IMAGES = 24
export const SHOT_VIDEO_VISUAL_REFERENCE_MAX_REFERENCES = 9

export type ShotVideoVisualCandidateKind =
  | 'storyboard'
  | 'character-primary'
  | 'character-front'
  | 'character-side'
  | 'character-back'
  | 'location'
  | 'prop'

export type ShotVideoVisualCharacterView =
  | 'front'
  | 'side'
  | 'back'
  | 'not_required'
  | 'uncertain'

export interface ShotVideoVisualReferenceCandidate {
  visualId: string
  assetId: string
  assetVersion: number
  assetChecksum: string
  assetSourceRevisionId: string
  kind: ShotVideoVisualCandidateKind
  entityId: string
  entityName: string
  /** Character primary art is visible to the Agent but cannot masquerade as a role slot. */
  selectable: boolean
  dataUrl: string
}

export type ShotVideoVisualReferenceBoundCandidate = Omit<
  ShotVideoVisualReferenceCandidate,
  'dataUrl'
>

export interface ShotVideoVisualReferenceShot {
  shotId: string
  sceneId: string
  code: string
  title: string
  description: string
  framing: string
  movement: string
  prompt: string
  candidateVisualIds: string[]
  storyboardVisualId: string | null
  characters: Array<{ characterId: string; characterName: string }>
}

export interface ShotVideoVisualReferenceAnalysisInput {
  projectId: string
  episodeId: string
  sourceRevisionId: string
  shots: ShotVideoVisualReferenceShot[]
  candidates: ShotVideoVisualReferenceCandidate[]
  idempotencyKey?: string
}

export interface ShotVideoVisualReferenceModelShot {
  shotId: string
  strategy: 'first_frame' | 'multi_reference' | 'text_only' | 'manual_review'
  compositionAnchorVisualId: string | null
  referenceVisualIds: string[]
  characterViews: Array<{
    characterId: string
    view: ShotVideoVisualCharacterView
    confidence: number
    rationale: string
  }>
  confidence: number
  rationale: string
  visualEvidence: string[]
}

export interface ShotVideoVisualReferencePlan {
  shotId: string
  sceneId: string
  status: 'recommended' | 'manual_required'
  strategy: 'first_frame' | 'multi_reference' | 'text_only' | 'manual_review'
  confidence: number
  rationale: string
  visualEvidence: string[]
  selectedReferences: Array<{
    assetId: string
    role: 'first_frame' | 'reference_image'
    purpose: string
  }>
  missingCharacterViews: Array<{
    characterId: string
    characterName: string
    view: 'front' | 'side' | 'back' | 'uncertain'
    rationale: string
  }>
}

export interface ShotVideoVisualReferenceAnalysis {
  version: typeof SHOT_VIDEO_VISUAL_REFERENCE_ANALYSIS_VERSION
  inputFingerprint: string
  projectId: string
  episodeId: string
  sourceRevisionId: string
  plans: ShotVideoVisualReferencePlan[]
}

export class ShotVideoVisualReferenceAnalysisError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'VISION_NOT_SUPPORTED'
      | 'INVALID_MODEL_OUTPUT',
    message: string,
  ) {
    super(message)
    this.name = 'ShotVideoVisualReferenceAnalysisError'
  }
}

export function isShotVideoVisualReferenceAnalysis(
  value: unknown,
): value is ShotVideoVisualReferenceAnalysis {
  if (!isRecord(value)
    || !exactKeys(value, [
      'version', 'inputFingerprint', 'projectId', 'episodeId', 'sourceRevisionId', 'plans',
    ])
    || value.version !== SHOT_VIDEO_VISUAL_REFERENCE_ANALYSIS_VERSION
    || typeof value.inputFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.inputFingerprint)
    || !boundedString(value.projectId, 256)
    || !boundedString(value.episodeId, 256)
    || !boundedString(value.sourceRevisionId, 256)
    || !Array.isArray(value.plans)
    || value.plans.length < 1
    || value.plans.length > 24) return false
  const shots = new Set<string>()
  return value.plans.every((plan) => {
    if (!isRecord(plan)
      || !exactKeys(plan, [
        'shotId', 'sceneId', 'status', 'strategy', 'confidence', 'rationale',
        'visualEvidence', 'selectedReferences', 'missingCharacterViews',
      ])
      || !boundedString(plan.shotId, 200)
      || shots.has(plan.shotId)
      || !boundedString(plan.sceneId, 200)
      || (plan.status !== 'recommended' && plan.status !== 'manual_required')
      || !['first_frame', 'multi_reference', 'text_only', 'manual_review'].includes(String(plan.strategy))
      || !finiteConfidence(plan.confidence)
      || !boundedString(plan.rationale, 2_000)
      || !Array.isArray(plan.visualEvidence)
      || plan.visualEvidence.length > 8
      || plan.visualEvidence.some((item) => !boundedString(item, 300))
      || !Array.isArray(plan.selectedReferences)
      || plan.selectedReferences.length > SHOT_VIDEO_VISUAL_REFERENCE_MAX_REFERENCES
      || !Array.isArray(plan.missingCharacterViews)
      || plan.missingCharacterViews.length > 16) return false
    shots.add(plan.shotId)
    const assetIds = new Set<string>()
    if (!plan.selectedReferences.every((reference) => {
      if (!isRecord(reference)
        || !exactKeys(reference, ['assetId', 'role', 'purpose'])
        || !boundedString(reference.assetId, 256)
        || assetIds.has(reference.assetId)
        || (reference.role !== 'first_frame' && reference.role !== 'reference_image')
        || !boundedString(reference.purpose, 500)) return false
      assetIds.add(reference.assetId)
      return true
    })) return false
    const characterIds = new Set<string>()
    if (!plan.missingCharacterViews.every((missing) => {
      if (!isRecord(missing)
        || !exactKeys(missing, ['characterId', 'characterName', 'view', 'rationale'])
        || !boundedString(missing.characterId, 200)
        || characterIds.has(missing.characterId)
        || !boundedString(missing.characterName, 300)
        || !['front', 'side', 'back', 'uncertain'].includes(String(missing.view))
        || !boundedString(missing.rationale, 800)) return false
      characterIds.add(missing.characterId)
      return true
    })) return false
    if (plan.status === 'recommended' && plan.missingCharacterViews.length !== 0) return false
    if (plan.status === 'manual_required' && plan.selectedReferences.length !== 0) return false
    if (plan.strategy === 'first_frame') {
      return plan.selectedReferences.length === 1
        && plan.selectedReferences[0]?.role === 'first_frame'
    }
    if (plan.strategy === 'multi_reference') {
      return plan.selectedReferences.length >= 1
        && plan.selectedReferences.every((reference) => isRecord(reference)
          && reference.role === 'reference_image')
    }
    return plan.selectedReferences.length === 0
  })
}

const MODEL_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['shots'],
  properties: {
    shots: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'shotId',
          'strategy',
          'compositionAnchorVisualId',
          'referenceVisualIds',
          'characterViews',
          'confidence',
          'rationale',
          'visualEvidence',
        ],
        properties: {
          shotId: { type: 'string', minLength: 1, maxLength: 200 },
          strategy: {
            type: 'string',
            enum: ['first_frame', 'multi_reference', 'text_only', 'manual_review'],
          },
          compositionAnchorVisualId: {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: 32 },
              { type: 'null' },
            ],
          },
          referenceVisualIds: {
            type: 'array',
            maxItems: SHOT_VIDEO_VISUAL_REFERENCE_MAX_REFERENCES,
            items: { type: 'string', minLength: 1, maxLength: 32 },
          },
          characterViews: {
            type: 'array',
            maxItems: 16,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['characterId', 'view', 'confidence', 'rationale'],
              properties: {
                characterId: { type: 'string', minLength: 1, maxLength: 200 },
                view: {
                  type: 'string',
                  enum: ['front', 'side', 'back', 'not_required', 'uncertain'],
                },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                rationale: { type: 'string', minLength: 1, maxLength: 800 },
              },
            },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rationale: { type: 'string', minLength: 1, maxLength: 1_200 },
          visualEvidence: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 300 },
          },
        },
      },
    },
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function finiteConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

export function shotVideoVisualReferenceInputFingerprint(
  input: Omit<ShotVideoVisualReferenceAnalysisInput, 'idempotencyKey' | 'candidates'> & {
    candidates: Array<ShotVideoVisualReferenceCandidate | ShotVideoVisualReferenceBoundCandidate>
  },
): string {
  return createHash('sha256').update(JSON.stringify(canonical({
    projectId: input.projectId,
    episodeId: input.episodeId,
    sourceRevisionId: input.sourceRevisionId,
    shots: input.shots.map((shot) => ({
      ...shot,
      candidateVisualIds: [...shot.candidateVisualIds],
      characters: shot.characters.map((character) => ({ ...character })),
    })),
    candidates: input.candidates.map((candidate) => {
      const { dataUrl: _dataUrl, ...bound } = candidate as ShotVideoVisualReferenceCandidate
      return bound
    }),
  }))).digest('hex')
}

function assertInput(input: ShotVideoVisualReferenceAnalysisInput): void {
  if (!boundedString(input.projectId, 256)
    || !boundedString(input.episodeId, 256)
    || !boundedString(input.sourceRevisionId, 256)
    || input.shots.length < 1
    || input.shots.length > 24
    || new Set(input.shots.map((shot) => shot.shotId)).size !== input.shots.length
    || input.candidates.length < 1
    || input.candidates.length > SHOT_VIDEO_VISUAL_REFERENCE_MAX_IMAGES
    || new Set(input.candidates.map((candidate) => candidate.visualId)).size !== input.candidates.length
    || new Set(input.candidates.map((candidate) => candidate.assetId)).size !== input.candidates.length) {
    throw new ShotVideoVisualReferenceAnalysisError('INVALID_INPUT', '逐镜视觉参考分析输入无效')
  }
  const candidates = new Map(input.candidates.map((candidate) => [candidate.visualId, candidate]))
  for (const candidate of input.candidates) {
    if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(candidate.visualId)
      || !boundedString(candidate.assetId, 256)
      || !Number.isInteger(candidate.assetVersion)
      || candidate.assetVersion < 1
      || !/^[a-f0-9]{64}$/.test(candidate.assetChecksum)
      || candidate.assetSourceRevisionId !== input.sourceRevisionId
      || !boundedString(candidate.entityId, 256)
      || !boundedString(candidate.entityName, 300)
      || !candidate.dataUrl.startsWith('data:image/')) {
      throw new ShotVideoVisualReferenceAnalysisError('INVALID_INPUT', `视觉候选 ${candidate.visualId} 无效`)
    }
  }
  for (const shot of input.shots) {
    const tokenSet = new Set(shot.candidateVisualIds)
    if (!boundedString(shot.shotId, 200)
      || !boundedString(shot.sceneId, 200)
      || tokenSet.size !== shot.candidateVisualIds.length
      || shot.candidateVisualIds.some((visualId) => !candidates.has(visualId))
      || (shot.storyboardVisualId !== null
        && (!tokenSet.has(shot.storyboardVisualId)
          || candidates.get(shot.storyboardVisualId)?.kind !== 'storyboard'))
      || new Set(shot.characters.map((character) => character.characterId)).size !== shot.characters.length) {
      throw new ShotVideoVisualReferenceAnalysisError('INVALID_INPUT', `镜头 ${shot.shotId} 的视觉候选范围无效`)
    }
  }
}

function validateModelOutput(
  value: unknown,
  input: ShotVideoVisualReferenceAnalysisInput,
): ShotVideoVisualReferenceModelShot[] {
  if (!isRecord(value)
    || !exactKeys(value, ['shots'])
    || !Array.isArray(value.shots)
    || value.shots.length !== input.shots.length) {
    throw new ShotVideoVisualReferenceAnalysisError('INVALID_MODEL_OUTPUT', '视觉模型未返回完整的逐镜计划')
  }
  const expected = new Map(input.shots.map((shot) => [shot.shotId, shot]))
  const candidateByVisualId = new Map(input.candidates.map((candidate) => [candidate.visualId, candidate]))
  const seen = new Set<string>()
  const output: ShotVideoVisualReferenceModelShot[] = []
  for (const raw of value.shots) {
    if (!isRecord(raw)
      || !exactKeys(raw, [
        'shotId', 'strategy', 'compositionAnchorVisualId', 'referenceVisualIds',
        'characterViews', 'confidence', 'rationale', 'visualEvidence',
      ])
      || !boundedString(raw.shotId, 200)
      || seen.has(raw.shotId)
      || !expected.has(raw.shotId)
      || !['first_frame', 'multi_reference', 'text_only', 'manual_review'].includes(String(raw.strategy))
      || (raw.compositionAnchorVisualId !== null && !boundedString(raw.compositionAnchorVisualId, 32))
      || !Array.isArray(raw.referenceVisualIds)
      || raw.referenceVisualIds.some((visualId) => !boundedString(visualId, 32))
      || new Set(raw.referenceVisualIds).size !== raw.referenceVisualIds.length
      || !Array.isArray(raw.characterViews)
      || !finiteConfidence(raw.confidence)
      || !boundedString(raw.rationale, 1_200)
      || !Array.isArray(raw.visualEvidence)
      || raw.visualEvidence.length > 8
      || raw.visualEvidence.some((evidence) => !boundedString(evidence, 300))) {
      throw new ShotVideoVisualReferenceAnalysisError('INVALID_MODEL_OUTPUT', '视觉模型输出的镜头计划无效')
    }
    const shot = expected.get(raw.shotId)!
    const allowed = new Set(shot.candidateVisualIds)
    const anchor = raw.compositionAnchorVisualId
    if (anchor !== null
      && (anchor !== shot.storyboardVisualId || !allowed.has(anchor))) {
      throw new ShotVideoVisualReferenceAnalysisError('INVALID_MODEL_OUTPUT', `镜头 ${raw.shotId} 引用了非本镜分镜锚点`)
    }
    if (raw.referenceVisualIds.length > SHOT_VIDEO_VISUAL_REFERENCE_MAX_REFERENCES
      || raw.referenceVisualIds.some((visualId) => (
        !allowed.has(visualId)
        || visualId === anchor
        || candidateByVisualId.get(visualId)?.selectable !== true
      ))) {
      throw new ShotVideoVisualReferenceAnalysisError('INVALID_MODEL_OUTPUT', `镜头 ${raw.shotId} 引用了未授权的参考图`)
    }
    if ((raw.strategy === 'first_frame' && (anchor === null || raw.referenceVisualIds.length !== 0))
      || (raw.strategy === 'multi_reference' && raw.referenceVisualIds.length < 1)
      || (raw.strategy === 'text_only' && (anchor !== null || raw.referenceVisualIds.length !== 0))) {
      throw new ShotVideoVisualReferenceAnalysisError('INVALID_MODEL_OUTPUT', `镜头 ${raw.shotId} 的策略与参考图冲突`)
    }
    const expectedCharacters = new Map(shot.characters.map((character) => [character.characterId, character]))
    const characterViews = raw.characterViews as unknown[]
    if (characterViews.length !== expectedCharacters.size) {
      throw new ShotVideoVisualReferenceAnalysisError('INVALID_MODEL_OUTPUT', `镜头 ${raw.shotId} 的角色视角判断不完整`)
    }
    const characterSeen = new Set<string>()
    for (const decision of characterViews) {
      if (!isRecord(decision)
        || !exactKeys(decision, ['characterId', 'view', 'confidence', 'rationale'])
        || !boundedString(decision.characterId, 200)
        || characterSeen.has(decision.characterId)
        || !expectedCharacters.has(decision.characterId)
        || !['front', 'side', 'back', 'not_required', 'uncertain'].includes(String(decision.view))
        || !finiteConfidence(decision.confidence)
        || !boundedString(decision.rationale, 800)) {
        throw new ShotVideoVisualReferenceAnalysisError('INVALID_MODEL_OUTPUT', `镜头 ${raw.shotId} 的角色视角证据无效`)
      }
      characterSeen.add(decision.characterId)
    }
    seen.add(raw.shotId)
    output.push(raw as unknown as ShotVideoVisualReferenceModelShot)
  }
  return input.shots.map((shot) => output.find((candidate) => candidate.shotId === shot.shotId)!)
}

function prompt(input: ShotVideoVisualReferenceAnalysisInput): string {
  const candidates = new Map(input.candidates.map((candidate) => [candidate.visualId, candidate]))
  return [
    '你要为 Seedance 逐镜视频选择参考图。必须真正阅读图像，不得只用文本关键词。',
    '当前分镜可作构图锚点；角色正/侧/背槽用于身份一致性；道具和场景图仅在画面确实需要时选择。',
    '不要选择下一镜分镜当尾帧；不要为运动强行堆满参考图。视觉证据不足时返回 manual_review/uncertain。',
    '角色主设定图可供你理解角色，但 selectable=false，不得把它当成正/侧/背槽输出。',
    ...input.shots.map((shot) => JSON.stringify({
      shotId: shot.shotId,
      sceneId: shot.sceneId,
      code: shot.code,
      title: shot.title,
      description: shot.description,
      framing: shot.framing,
      movement: shot.movement,
      prompt: shot.prompt,
      storyboardVisualId: shot.storyboardVisualId,
      characters: shot.characters,
      candidates: shot.candidateVisualIds.map((visualId) => {
        const candidate = candidates.get(visualId)!
        return {
          visualId,
          kind: candidate.kind,
          entityId: candidate.entityId,
          entityName: candidate.entityName,
          selectable: candidate.selectable,
        }
      }),
    })),
  ].join('\n')
}

function rolePurpose(candidate: ShotVideoVisualReferenceCandidate): string {
  if (candidate.kind === 'storyboard') return '当前镜头内容与构图'
  if (candidate.kind.startsWith('character-')) return `角色${candidate.kind.slice('character-'.length)}视角一致性`
  if (candidate.kind === 'prop') return `道具造型：${candidate.entityName}`
  return `场景空间与风格：${candidate.entityName}`
}

function buildPlan(
  shot: ShotVideoVisualReferenceShot,
  model: ShotVideoVisualReferenceModelShot,
  candidates: Map<string, ShotVideoVisualReferenceCandidate>,
): ShotVideoVisualReferencePlan {
  const selectedVisualIds = [...model.referenceVisualIds]
  const missingCharacterViews: ShotVideoVisualReferencePlan['missingCharacterViews'] = []
  for (const decision of model.characterViews) {
    const identity = shot.characters.find((character) => character.characterId === decision.characterId)!
    if (decision.view === 'uncertain') {
      missingCharacterViews.push({
        ...identity,
        view: 'uncertain',
        rationale: decision.rationale,
      })
      continue
    }
    if (decision.view === 'not_required') continue
    const slotKind = `character-${decision.view}` as ShotVideoVisualCandidateKind
    const slot = shot.candidateVisualIds
      .map((visualId) => candidates.get(visualId)!)
      .find((candidate) => candidate.kind === slotKind && candidate.entityId === decision.characterId)
    if (!slot) {
      missingCharacterViews.push({
        ...identity,
        view: decision.view,
        rationale: decision.rationale,
      })
    } else if (!selectedVisualIds.includes(slot.visualId)) {
      selectedVisualIds.push(slot.visualId)
    }
  }
  const anchor = model.compositionAnchorVisualId ? candidates.get(model.compositionAnchorVisualId)! : null
  const selected = selectedVisualIds.map((visualId) => candidates.get(visualId)!)
  const overLimit = (anchor ? 1 : 0) + selected.length > SHOT_VIDEO_VISUAL_REFERENCE_MAX_REFERENCES
  const manual = model.strategy === 'manual_review'
    || model.confidence < SHOT_VIDEO_VISUAL_REFERENCE_CONFIDENCE_THRESHOLD
    || model.characterViews.some((decision) => (
      decision.view !== 'not_required'
      && decision.confidence < SHOT_VIDEO_VISUAL_REFERENCE_CONFIDENCE_THRESHOLD
    ))
    || missingCharacterViews.length > 0
    || overLimit
  const effectiveStrategy: ShotVideoVisualReferencePlan['strategy'] = manual
    ? 'manual_review'
    : selected.length > 0
      ? 'multi_reference'
      : model.strategy
  const bindings = manual
    ? []
    : selected.length > 0
      ? [
          ...(anchor ? [{ assetId: anchor.assetId, role: 'reference_image' as const, purpose: rolePurpose(anchor) }] : []),
          ...selected.map((candidate) => ({
            assetId: candidate.assetId,
            role: 'reference_image' as const,
            purpose: rolePurpose(candidate),
          })),
        ]
      : anchor
        ? [{ assetId: anchor.assetId, role: 'first_frame' as const, purpose: rolePurpose(anchor) }]
        : []
  return {
    shotId: shot.shotId,
    sceneId: shot.sceneId,
    status: manual ? 'manual_required' : 'recommended',
    strategy: effectiveStrategy,
    confidence: model.confidence,
    rationale: overLimit
      ? `${model.rationale}；组合超过 ${SHOT_VIDEO_VISUAL_REFERENCE_MAX_REFERENCES} 张 Provider 上限。`
      : model.rationale,
    visualEvidence: [...model.visualEvidence],
    selectedReferences: bindings,
    missingCharacterViews,
  }
}

export async function analyzeShotVideoVisualReferences(
  provider: TextProvider,
  input: ShotVideoVisualReferenceAnalysisInput,
  signal: AbortSignal,
): Promise<ShotVideoVisualReferenceAnalysis> {
  assertInput(input)
  if (!provider.generateVisualStructured) {
    throw new ShotVideoVisualReferenceAnalysisError(
      'VISION_NOT_SUPPORTED',
      '当前文本 Provider 不支持受控多模态结构输出，不会降级成文本猜测',
    )
  }
  const modelShots = await provider.generateVisualStructured(
    {
      systemPrompt: '你是漫剧视频参考图导演。你的输出将经过 Asset 身份、角色槽位、修订和 Provider 上限的确定性校验。',
      userPrompt: prompt(input),
      schemaName: 'shot_video_visual_reference_plan',
      schema: MODEL_SCHEMA,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      images: input.candidates.map((candidate) => ({
        label: candidate.visualId,
        dataUrl: candidate.dataUrl,
        detail: candidate.kind === 'storyboard' ? 'high' as const : 'low' as const,
      })),
    },
    (value) => validateModelOutput(value, input),
    signal,
  )
  const candidates = new Map(input.candidates.map((candidate) => [candidate.visualId, candidate]))
  const { idempotencyKey: _idempotencyKey, ...fingerprintInput } = input
  return {
    version: SHOT_VIDEO_VISUAL_REFERENCE_ANALYSIS_VERSION,
    inputFingerprint: shotVideoVisualReferenceInputFingerprint(fingerprintInput),
    projectId: input.projectId,
    episodeId: input.episodeId,
    sourceRevisionId: input.sourceRevisionId,
    plans: input.shots.map((shot, index) => buildPlan(shot, modelShots[index]!, candidates)),
  }
}
