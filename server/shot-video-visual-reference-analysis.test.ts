import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  StructuredGenerationInput,
  TextProvider,
  VisualStructuredGenerationInput,
} from './providers/text.js'
import {
  analyzeShotVideoVisualReferences,
  ShotVideoVisualReferenceAnalysisError,
  shotVideoVisualReferenceInputFingerprint,
  type ShotVideoVisualReferenceAnalysisInput,
  type ShotVideoVisualReferenceCandidate,
  type ShotVideoVisualReferenceModelShot,
  type ShotVideoVisualReferenceShot,
} from './shot-video-visual-reference-analysis.js'

const REVISION = 'revision-1'
const IMAGE = 'data:image/png;base64,iVBORw0KGgo='

function candidate(
  visualId: string,
  kind: ShotVideoVisualReferenceCandidate['kind'],
  options: Partial<ShotVideoVisualReferenceCandidate> = {},
): ShotVideoVisualReferenceCandidate {
  return {
    visualId,
    assetId: options.assetId ?? `asset-${visualId.toLowerCase()}`,
    assetVersion: options.assetVersion ?? 1,
    assetChecksum: options.assetChecksum ?? 'a'.repeat(64),
    assetSourceRevisionId: REVISION,
    kind,
    entityId: options.entityId ?? visualId.toLowerCase(),
    entityName: options.entityName ?? visualId,
    selectable: options.selectable ?? kind !== 'character-primary',
    dataUrl: options.dataUrl ?? IMAGE,
  }
}

function shot(
  shotId: string,
  candidateVisualIds: string[],
  options: Partial<ShotVideoVisualReferenceShot> = {},
): ShotVideoVisualReferenceShot {
  return {
    shotId,
    sceneId: options.sceneId ?? 's0',
    code: options.code ?? shotId.toUpperCase(),
    title: options.title ?? shotId,
    description: options.description ?? '镜头描述',
    framing: options.framing ?? '中景',
    movement: options.movement ?? '静止',
    prompt: options.prompt ?? '国风动画',
    candidateVisualIds,
    storyboardVisualId: options.storyboardVisualId ?? candidateVisualIds.find((visualId) => visualId.startsWith('SB_')) ?? null,
    characters: options.characters ?? [],
  }
}

function input(
  shots: ShotVideoVisualReferenceShot[],
  candidates: ShotVideoVisualReferenceCandidate[],
): ShotVideoVisualReferenceAnalysisInput {
  return {
    projectId: 'project-1',
    episodeId: 'episode-1',
    sourceRevisionId: REVISION,
    shots,
    candidates,
    idempotencyKey: 'vision-job-1',
  }
}

class VisualStubProvider implements TextProvider {
  readonly name = 'vision-stub'
  readonly model = 'vision-model'
  readonly configured = true
  constructor(private readonly output: { shots: ShotVideoVisualReferenceModelShot[] }) {}
  async listModels(): Promise<string[]> { return [this.model] }
  async generateStructured<T>(
    _input: StructuredGenerationInput,
    _validate: (value: unknown) => T,
  ): Promise<T> {
    throw new Error('text-only generation must not be used')
  }
  async generateVisualStructured<T>(
    request: VisualStructuredGenerationInput,
    validate: (value: unknown) => T,
  ): Promise<T> {
    assert.match(request.userPrompt, /必须真正阅读图像/)
    assert.equal(request.images.length > 0, true)
    return validate(this.output)
  }
}

function modelShot(
  shotId: string,
  options: Partial<ShotVideoVisualReferenceModelShot> = {},
): ShotVideoVisualReferenceModelShot {
  return {
    shotId,
    strategy: options.strategy ?? 'first_frame',
    compositionAnchorVisualId: options.compositionAnchorVisualId ?? `SB_${shotId.toUpperCase()}`,
    referenceVisualIds: options.referenceVisualIds ?? [],
    characterViews: options.characterViews ?? [],
    confidence: options.confidence ?? 0.9,
    rationale: options.rationale ?? '当前分镜已稳定构图',
    visualEvidence: options.visualEvidence ?? ['主体和场景边界清晰'],
  }
}

test('vision agent keeps a distant establishing shot as same-shot first frame', async () => {
  const storyboard = candidate('SB_SH0', 'storyboard', { entityId: 'sh0' })
  const analysis = await analyzeShotVideoVisualReferences(
    new VisualStubProvider({ shots: [modelShot('sh0')] }),
    input([shot('sh0', ['SB_SH0'], { framing: '高空远景' })], [storyboard]),
    new AbortController().signal,
  )
  assert.equal(analysis.plans[0]?.status, 'recommended')
  assert.equal(analysis.plans[0]?.strategy, 'first_frame')
  assert.deepEqual(analysis.plans[0]?.selectedReferences, [{
    assetId: storyboard.assetId,
    role: 'first_frame',
    purpose: '当前镜头内容与构图',
  }])
})

test('vision agent composes storyboard and visibly important prop as multi-reference', async () => {
  const storyboard = candidate('SB_SH2', 'storyboard', { entityId: 'sh2' })
  const visualId = candidate('PROP_TOKEN', 'prop', { entityId: 'p_token', entityName: '青铜令' })
  const location = candidate('LOC_CLIFF', 'location', { entityId: 'loc_cliff', entityName: '秦岭断崖' })
  const analysis = await analyzeShotVideoVisualReferences(
    new VisualStubProvider({ shots: [modelShot('sh2', {
      strategy: 'multi_reference',
      referenceVisualIds: ['PROP_TOKEN'],
      rationale: '道具占据画面主体，需要锁定青铜纹理',
    })] }),
    input([shot('sh2', ['SB_SH2', 'PROP_TOKEN', 'LOC_CLIFF'], {
      framing: '特写',
      description: '青铜令从沉暗变得滚烫',
    })], [storyboard, visualId, location]),
    new AbortController().signal,
  )
  assert.equal(analysis.plans[0]?.strategy, 'multi_reference')
  assert.deepEqual(analysis.plans[0]?.selectedReferences.map(({ assetId, role }) => ({ assetId, role })), [
    { assetId: storyboard.assetId, role: 'reference_image' },
    { assetId: visualId.assetId, role: 'reference_image' },
  ])
})

test('identity-sensitive visual decision requires the real character view slot', async () => {
  const storyboard = candidate('SB_SH3', 'storyboard', { entityId: 'sh3' })
  const primary = candidate('CHAR_ALI', 'character-primary', {
    entityId: 'c_ali',
    entityName: '阿离',
    selectable: false,
  })
  const visualDecision = modelShot('sh3', {
    characterViews: [{
      characterId: 'c_ali',
      view: 'front',
      confidence: 0.94,
      rationale: '画面是正面面部近景',
    }],
  })
  const withoutSlot = await analyzeShotVideoVisualReferences(
    new VisualStubProvider({ shots: [visualDecision] }),
    input([shot('sh3', ['SB_SH3', 'CHAR_ALI'], {
      characters: [{ characterId: 'c_ali', characterName: '阿离' }],
    })], [storyboard, primary]),
    new AbortController().signal,
  )
  assert.equal(withoutSlot.plans[0]?.status, 'manual_required')
  assert.deepEqual(withoutSlot.plans[0]?.selectedReferences, [])
  assert.equal(withoutSlot.plans[0]?.missingCharacterViews[0]?.view, 'front')

  const front = candidate('CHAR_ALI_FRONT', 'character-front', {
    entityId: 'c_ali',
    entityName: '阿离',
  })
  const withSlot = await analyzeShotVideoVisualReferences(
    new VisualStubProvider({ shots: [visualDecision] }),
    input([shot('sh3', ['SB_SH3', 'CHAR_ALI', 'CHAR_ALI_FRONT'], {
      characters: [{ characterId: 'c_ali', characterName: '阿离' }],
    })], [storyboard, primary, front]),
    new AbortController().signal,
  )
  assert.equal(withSlot.plans[0]?.status, 'recommended')
  assert.equal(withSlot.plans[0]?.strategy, 'multi_reference')
  assert.deepEqual(withSlot.plans[0]?.selectedReferences.map(({ assetId }) => assetId), [
    storyboard.assetId,
    front.assetId,
  ])
})

test('model cannot smuggle another shot storyboard or analysis-only primary into references', async () => {
  const first = candidate('SB_SH0', 'storyboard', { entityId: 'sh0' })
  const next = candidate('SB_SH1', 'storyboard', { entityId: 'sh1' })
  const provider = new VisualStubProvider({ shots: [modelShot('sh0', {
    strategy: 'multi_reference',
    referenceVisualIds: ['SB_SH1'],
  })] })
  await assert.rejects(analyzeShotVideoVisualReferences(
    provider,
    input([shot('sh0', ['SB_SH0'])], [first, next]),
    new AbortController().signal,
  ), (error: unknown) => {
    assert.ok(error instanceof ShotVideoVisualReferenceAnalysisError)
    assert.equal(error.code, 'INVALID_MODEL_OUTPUT')
    return true
  })
})

test('low-confidence visual decisions are review-only and image bytes do not affect binding fingerprint', async () => {
  const storyboard = candidate('SB_SH7', 'storyboard', { entityId: 'sh7' })
  const request = input([shot('sh7', ['SB_SH7'])], [storyboard])
  const analysis = await analyzeShotVideoVisualReferences(
    new VisualStubProvider({ shots: [modelShot('sh7', { confidence: 0.4 })] }),
    request,
    new AbortController().signal,
  )
  assert.equal(analysis.plans[0]?.status, 'manual_required')
  assert.equal(analysis.plans[0]?.strategy, 'manual_review')
  const { idempotencyKey: _key, ...bound } = request
  assert.equal(
    shotVideoVisualReferenceInputFingerprint(bound),
    shotVideoVisualReferenceInputFingerprint({
      ...bound,
      candidates: [{ ...storyboard, dataUrl: 'data:image/png;base64,AAAA' }],
    }),
  )
})
