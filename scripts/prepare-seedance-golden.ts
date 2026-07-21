import { createHash, randomBytes } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import type {
  SeedanceGoldenAxis,
  SeedanceGoldenMetric,
} from './verify-seedance-golden.js'
import { SEEDANCE_GOLDEN_METRICS } from './verify-seedance-golden.js'

type JsonRecord = Record<string, unknown>

export interface SeedanceGoldenJobPair {
  candidateJobId: string
  baselineJobId: string
}

export interface SeedanceGoldenDraftReview {
  reviewerId: ''
  reviewedAt: ''
  playbackComplete: false
  scores: Record<SeedanceGoldenMetric, 0>
  notes: ''
}

export interface SeedanceGoldenDraftVariant {
  id: string
  blindLabel: 'A' | 'B'
  role: 'candidate' | 'baseline'
  jobId: string
  providerTaskId: string
  outputAssetId: string
  outputChecksum: string
  sourceRevisionId: string
  timingManifestFingerprint: string
  providerId: string
  providerConfigRevision: number
  model: string
  durationSeconds: number
  resolution: '480p' | '720p' | '1080p'
  audioPolicy: 'silent' | 'sfx_only' | 'provider_audio'
  generationMode: 'sequential' | 'continuous'
  promptCompilerVersion: string
  promptChecksum: string
  referenceStrategy: string
  referenceFingerprint: string
  includeTimecodes: boolean
  latencySeconds: number
  providerCost: null
  providerCostEvidence: 'unavailable'
  completedAt: string
  review: SeedanceGoldenDraftReview
}

export interface SeedanceGoldenManifestDraft {
  version: 1
  name: string
  episodeId: string
  comparisonAxis: SeedanceGoldenAxis
  createdAt: string
  policy: {
    nonInferiorityMargin: number
    minimumCandidateScore: number
    maximumPerCaseRegression: number
  }
  cases: Array<{
    sceneId: string
    shotId: string
    variants: [SeedanceGoldenDraftVariant, SeedanceGoldenDraftVariant]
  }>
}

export interface SeedanceGoldenBlindReviewSheet {
  version: 1
  manifestName: string
  episodeId: string
  comparisonAxis: SeedanceGoldenAxis
  reviewerId: ''
  reviewedAt: ''
  instructions: readonly string[]
  cases: Array<{
    sceneId: string
    shotId: string
    variants: Array<{
      blindLabel: 'A' | 'B'
      assetId: string
      contentUrl: string
      playbackComplete: false
      scores: Record<SeedanceGoldenMetric, 0>
      notes: ''
    }>
  }>
}

export class SeedanceGoldenPreparationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedanceGoldenPreparationError'
  }
}

interface AuthorityJobRow {
  id: string
  project_id: string
  episode_id: string | null
  status: string
  provider_id: string | null
  model: string | null
  provider_config_revision: number | null
  external_task_id: string | null
  input_json: string
  output_json: string | null
  started_at: string | null
  completed_at: string | null
}

interface AuthorityAssetRow {
  id: string
  project_id: string
  episode_id: string | null
  kind: string
  version: number
  status: string
  file_path: string | null
  mime_type: string | null
  duration_seconds: number | null
  checksum: string | null
  generation_job_id: string | null
  source_revision_id: string | null
}

interface PreparedAuthorityVariant {
  sceneId: string
  shotId: string
  controlled: Omit<SeedanceGoldenDraftVariant, 'id' | 'blindLabel' | 'role' | 'review'>
}

const HASH = /^[a-f0-9]{64}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/
const AXES = new Set<SeedanceGoldenAxis>([
  'prompt_strategy',
  'reference_strategy',
  'timecode_instruction',
  'resolution',
  'audio_policy',
  'generation_mode',
])
type SeedanceGoldenControlledVariant = Omit<SeedanceGoldenDraftVariant, 'id' | 'blindLabel' | 'role' | 'review'>

const CONTROLLED_FIELDS = [
  'sourceRevisionId', 'timingManifestFingerprint', 'providerId', 'providerConfigRevision', 'model',
  'durationSeconds', 'resolution', 'audioPolicy', 'generationMode', 'promptCompilerVersion',
  'promptChecksum', 'referenceStrategy', 'referenceFingerprint', 'includeTimecodes',
] as const satisfies readonly (keyof SeedanceGoldenControlledVariant)[]
const AXIS_ALLOWED_DIFFERENCES: Record<SeedanceGoldenAxis, ReadonlySet<keyof SeedanceGoldenDraftVariant>> = {
  prompt_strategy: new Set(['promptCompilerVersion', 'promptChecksum']),
  reference_strategy: new Set(['referenceStrategy', 'referenceFingerprint']),
  timecode_instruction: new Set(['includeTimecodes', 'promptChecksum']),
  resolution: new Set(['resolution']),
  audio_policy: new Set(['audioPolicy', 'promptChecksum']),
  generation_mode: new Set(['generationMode']),
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SeedanceGoldenPreparationError(`${path} 必须是对象`)
  }
  return value as JsonRecord
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) {
    throw new SeedanceGoldenPreparationError(`${path} 必须是非空文本`)
  }
  return value
}

function integer(value: unknown, path: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new SeedanceGoldenPreparationError(`${path} 必须是大于等于 ${minimum} 的整数`)
  }
  return value as number
}

function parseJson(value: string | null, path: string): JsonRecord {
  if (value === null) throw new SeedanceGoldenPreparationError(`${path} 缺失`)
  try {
    return record(JSON.parse(value) as unknown, path)
  } catch (error) {
    if (error instanceof SeedanceGoldenPreparationError) throw error
    throw new SeedanceGoldenPreparationError(`${path} 不是合法 JSON`)
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const item = value as JsonRecord
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(',')}}`
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function reviewPlaceholder(): SeedanceGoldenDraftReview {
  return {
    reviewerId: '',
    reviewedAt: '',
    playbackComplete: false,
    scores: Object.fromEntries(SEEDANCE_GOLDEN_METRICS.map((metric) => [metric, 0])) as Record<SeedanceGoldenMetric, 0>,
    notes: '',
  }
}

function referenceStrategy(references: unknown): string {
  if (!Array.isArray(references) || references.length === 0) return 'text-to-video'
  const roles = references.map((value, index) => string(record(value, `input.references[${index}]`).role, `input.references[${index}].role`))
  if (roles.every((role) => role === 'reference_image')) return 'multi-reference'
  if (roles.includes('last_frame')) return 'first-last-frame'
  if (roles.every((role) => role === 'first_frame')) return 'first-frame'
  throw new SeedanceGoldenPreparationError(`参考图角色组合不受 Golden 支持：${roles.join(', ')}`)
}

function promptHasTimecodes(prompt: string): boolean {
  return /(?:^|[\s；;，,])(?:\d{1,2}(?:\.\d+)?\s*[-–—至到]\s*)?\d{1,2}(?:\.\d+)?\s*(?:秒|s\b)/iu.test(prompt)
}

function elapsedSeconds(startedAt: string | null, completedAt: string | null, jobId: string): number {
  const start = Date.parse(string(startedAt, `Job ${jobId}.startedAt`))
  const end = Date.parse(string(completedAt, `Job ${jobId}.completedAt`))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 缺少可信生成耗时`)
  }
  return Number(((end - start) / 1_000).toFixed(3))
}

function mediaPath(databasePath: string, filePath: string): string {
  return resolve(dirname(databasePath), filePath)
}

async function assertAssetBytes(databasePath: string, asset: AuthorityAssetRow, label: string): Promise<void> {
  const filePath = string(asset.file_path, `${label}.filePath`)
  const checksum = string(asset.checksum, `${label}.checksum`)
  if (!HASH.test(checksum)) throw new SeedanceGoldenPreparationError(`${label}.checksum 不是 SHA-256`)
  let bytes: Uint8Array
  try {
    bytes = await readFile(mediaPath(databasePath, filePath))
  } catch {
    throw new SeedanceGoldenPreparationError(`${label} 的本地文件不存在或不可读`)
  }
  if (sha256(bytes) !== checksum) {
    throw new SeedanceGoldenPreparationError(`${label} 的本地字节与数据库 checksum 不一致`)
  }
}

function assetById(database: DatabaseSync, id: string, label: string): AuthorityAssetRow {
  const row = database.prepare(`
    SELECT id, project_id, episode_id, kind, version, status, file_path, mime_type,
           duration_seconds, checksum, generation_job_id, source_revision_id
      FROM media_assets WHERE id = ?
  `).get(id) as unknown as AuthorityAssetRow | undefined
  if (!row) throw new SeedanceGoldenPreparationError(`${label} ${id} 不存在`)
  return row
}

function currentSpeechBindings(database: DatabaseSync, databaseShotId: string): Array<{
  dialogueLineId: string
  assetId: string
  version: number
  checksum: string
  durationSeconds: number
  durationFrames: number
}> {
  const rows = database.prepare(`
    SELECT dialogue_lines.metadata_json, dialogue_lines.speech_asset_id,
           media_assets.id AS asset_id, media_assets.version, media_assets.checksum,
           media_assets.duration_seconds, media_assets.status, media_assets.mime_type
      FROM dialogue_lines
      LEFT JOIN media_assets ON media_assets.id = dialogue_lines.speech_asset_id
     WHERE dialogue_lines.shot_id = ?
     ORDER BY dialogue_lines.sequence ASC, dialogue_lines.id ASC
  `).all(databaseShotId) as Array<Record<string, unknown>>
  return rows.map((row, index) => {
    const metadata = parseJson(typeof row.metadata_json === 'string' ? row.metadata_json : null, `Dialogue ${index}.metadata`)
    const dialogueLineId = string(metadata.storyId, `Dialogue ${index}.metadata.storyId`)
    if (row.status !== 'ready'
      || typeof row.mime_type !== 'string'
      || !row.mime_type.startsWith('audio/')) {
      throw new SeedanceGoldenPreparationError(`当前台词 ${dialogueLineId} 尚无 ready 音频 Asset`)
    }
    const durationSeconds = typeof row.duration_seconds === 'number' ? row.duration_seconds : Number.NaN
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new SeedanceGoldenPreparationError(`当前台词 ${dialogueLineId} 的音频缺少可信时长`)
    }
    const checksum = string(row.checksum, `Dialogue ${dialogueLineId}.checksum`)
    if (!HASH.test(checksum)) throw new SeedanceGoldenPreparationError(`当前台词 ${dialogueLineId} 的音频 checksum 无效`)
    return {
      dialogueLineId,
      assetId: string(row.asset_id, `Dialogue ${dialogueLineId}.assetId`),
      version: integer(row.version, `Dialogue ${dialogueLineId}.version`),
      checksum,
      durationSeconds,
      durationFrames: Math.ceil(durationSeconds * 24),
    }
  })
}

function assertCurrentTiming(
  database: DatabaseSync,
  input: JsonRecord,
  binding: JsonRecord,
  jobId: string,
): JsonRecord {
  const decision = record(input.durationDecision, `Job ${jobId}.input.durationDecision`)
  if (decision.version !== 1 || decision.frameRate !== 24) {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 不是当前 24fps 音频优先 timing manifest`)
  }
  const databaseShotId = string(binding.databaseShotId, `Job ${jobId}.binding.databaseShotId`)
  const current = currentSpeechBindings(database, databaseShotId)
  const recorded = Array.isArray(decision.speechBindings) ? decision.speechBindings : null
  if (!recorded) throw new SeedanceGoldenPreparationError(`Job ${jobId} 的 speechBindings 无效`)
  if (current.length !== recorded.length) {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 的 timing manifest 已与当前台词音频数量漂移`)
  }
  const currentByLine = new Map(current.map((value) => [value.dialogueLineId, value]))
  for (const [index, raw] of recorded.entries()) {
    const value = record(raw, `Job ${jobId}.speechBindings[${index}]`)
    const lineId = string(value.dialogueLineId, `Job ${jobId}.speechBindings[${index}].dialogueLineId`)
    const expected = currentByLine.get(lineId)
    if (!expected
      || value.assetId !== expected.assetId
      || value.version !== expected.version
      || value.checksum !== expected.checksum
      || value.durationSeconds !== expected.durationSeconds
      || value.durationFrames !== expected.durationFrames) {
      throw new SeedanceGoldenPreparationError(`Job ${jobId} 的台词 ${lineId} timing 绑定已漂移`)
    }
  }
  if (current.length > 0 && decision.source !== 'speech_assets') {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 有真实语音却未使用 speech_assets 定时`)
  }
  return decision
}

async function loadAuthorityVariant(
  database: DatabaseSync,
  databasePath: string,
  episodeId: string,
  currentRevisionId: string,
  jobId: string,
): Promise<PreparedAuthorityVariant> {
  if (!IDENTIFIER.test(jobId)) throw new SeedanceGoldenPreparationError(`Job ID ${jobId} 格式无效`)
  const job = database.prepare(`
    SELECT id, project_id, episode_id, status, provider_id, model, provider_config_revision,
           external_task_id, input_json, output_json, started_at, completed_at
      FROM generation_jobs WHERE id = ? AND type = 'shot.video.generate'
  `).get(jobId) as unknown as AuthorityJobRow | undefined
  if (!job) throw new SeedanceGoldenPreparationError(`Seedance Job ${jobId} 不存在`)
  if (job.episode_id !== episodeId || job.status !== 'succeeded') {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 不属于当前 Episode 或尚未成功`)
  }
  const providerId = string(job.provider_id, `Job ${jobId}.providerId`)
  const model = string(job.model, `Job ${jobId}.model`)
  const providerConfigRevision = integer(job.provider_config_revision, `Job ${jobId}.providerConfigRevision`)
  const providerTaskId = string(job.external_task_id, `Job ${jobId}.externalTaskId`)
  const input = parseJson(job.input_json, `Job ${jobId}.input`)
  const output = parseJson(job.output_json, `Job ${jobId}.output`)
  const outputAsset = record(output.asset, `Job ${jobId}.output.asset`)
  const outputAssetId = string(outputAsset.id, `Job ${jobId}.output.asset.id`)
  if (output.externalTaskId !== providerTaskId) {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 的 Provider Task 回执不一致`)
  }
  const binding = record(input.binding, `Job ${jobId}.input.binding`)
  const sceneId = string(binding.sceneId, `Job ${jobId}.binding.sceneId`)
  const shotId = string(binding.shotId, `Job ${jobId}.binding.shotId`)
  const sourceRevisionId = string(binding.expectedRevisionId, `Job ${jobId}.binding.expectedRevisionId`)
  if (sourceRevisionId !== currentRevisionId) {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 绑定旧 Story revision，不能进入当前 Golden`)
  }
  const shot = database.prepare(`
    SELECT shots.source_revision_id, scenes.episode_id
      FROM shots JOIN scenes ON scenes.id = shots.scene_id
     WHERE shots.id = ?
  `).get(string(binding.databaseShotId, `Job ${jobId}.binding.databaseShotId`)) as Record<string, unknown> | undefined
  if (!shot || shot.episode_id !== episodeId || shot.source_revision_id !== currentRevisionId) {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 的当前镜头权威绑定已漂移`)
  }
  const durationDecision = assertCurrentTiming(database, input, binding, jobId)
  const durationSeconds = integer(input.durationSeconds, `Job ${jobId}.input.durationSeconds`, 4)
  if (durationSeconds > 15 || durationDecision.providerDurationSeconds !== durationSeconds) {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 的 Provider 时长与 timing manifest 不一致`)
  }
  const spec = record(input.spec, `Job ${jobId}.input.spec`)
  if (spec.sourceRevisionId !== currentRevisionId || spec.durationSeconds !== durationSeconds) {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 的结构化生成规格已漂移`)
  }
  const resolution = string(input.resolution, `Job ${jobId}.input.resolution`)
  if (resolution !== '480p' && resolution !== '720p' && resolution !== '1080p') {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 的分辨率不受支持`)
  }
  const audioPolicy = string(spec.audioPolicy, `Job ${jobId}.input.spec.audioPolicy`)
  if (audioPolicy !== 'silent' && audioPolicy !== 'sfx_only' && audioPolicy !== 'provider_audio') {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 的音频策略无效`)
  }
  const prompt = string(input.prompt, `Job ${jobId}.input.prompt`)
  const references = input.references ?? []
  if (!Array.isArray(references)) throw new SeedanceGoldenPreparationError(`Job ${jobId}.input.references 必须是数组`)
  for (const [index, rawReference] of references.entries()) {
    const reference = record(rawReference, `Job ${jobId}.references[${index}]`)
    const referenceAsset = assetById(database, string(reference.assetId, `Job ${jobId}.references[${index}].assetId`), '参考 Asset')
    if (referenceAsset.project_id !== job.project_id
      || referenceAsset.episode_id !== episodeId
      || referenceAsset.status !== 'ready'
      || referenceAsset.version !== reference.version
      || referenceAsset.checksum !== reference.checksum
      || referenceAsset.source_revision_id !== currentRevisionId) {
      throw new SeedanceGoldenPreparationError(`Job ${jobId} 的参考 Asset ${referenceAsset.id} 已漂移`)
    }
    await assertAssetBytes(databasePath, referenceAsset, `参考 Asset ${referenceAsset.id}`)
  }
  const asset = assetById(database, outputAssetId, '输出 Asset')
  if (asset.project_id !== job.project_id
    || asset.episode_id !== episodeId
    || asset.kind !== 'shot.video'
    || asset.status !== 'ready'
    || asset.generation_job_id !== jobId
    || asset.source_revision_id !== currentRevisionId
    || (asset.mime_type !== 'video/mp4' && asset.mime_type !== 'video/webm')
    || !asset.checksum
    || !HASH.test(asset.checksum)) {
    throw new SeedanceGoldenPreparationError(`Job ${jobId} 的输出 Asset 不是当前可验证视频`)
  }
  await assertAssetBytes(databasePath, asset, `输出 Asset ${asset.id}`)
  const generationMode = input.generationMode === 'continuous' ? 'continuous' : 'sequential'
  return {
    sceneId,
    shotId,
    controlled: {
      jobId,
      providerTaskId,
      outputAssetId,
      outputChecksum: asset.checksum,
      sourceRevisionId,
      timingManifestFingerprint: sha256(canonicalJson(durationDecision)),
      providerId,
      providerConfigRevision,
      model,
      durationSeconds,
      resolution,
      audioPolicy,
      generationMode,
      promptCompilerVersion: string(spec.promptCompilerVersion, `Job ${jobId}.spec.promptCompilerVersion`),
      promptChecksum: sha256(prompt),
      referenceStrategy: referenceStrategy(references),
      referenceFingerprint: sha256(canonicalJson(references)),
      includeTimecodes: promptHasTimecodes(prompt),
      latencySeconds: elapsedSeconds(job.started_at, job.completed_at, jobId),
      providerCost: null,
      providerCostEvidence: 'unavailable',
      completedAt: string(job.completed_at, `Job ${jobId}.completedAt`),
    },
  }
}

function assertControlledPair(
  axis: SeedanceGoldenAxis,
  candidate: PreparedAuthorityVariant,
  baseline: PreparedAuthorityVariant,
): void {
  if (candidate.sceneId !== baseline.sceneId || candidate.shotId !== baseline.shotId) {
    throw new SeedanceGoldenPreparationError(`A/B Job 不属于同一镜头：${candidate.sceneId}/${candidate.shotId} 与 ${baseline.sceneId}/${baseline.shotId}`)
  }
  const allowed = AXIS_ALLOWED_DIFFERENCES[axis] as ReadonlySet<keyof SeedanceGoldenControlledVariant>
  for (const field of CONTROLLED_FIELDS) {
    if (!allowed.has(field) && candidate.controlled[field] !== baseline.controlled[field]) {
      throw new SeedanceGoldenPreparationError(`${candidate.sceneId}/${candidate.shotId} 除 ${axis} 外的 ${field} 不一致`)
    }
  }
  if (![...allowed].some((field) => candidate.controlled[field] !== baseline.controlled[field])) {
    throw new SeedanceGoldenPreparationError(`${candidate.sceneId}/${candidate.shotId} 的 ${axis} 没有形成真实 A/B 差异`)
  }
  if (axis === 'prompt_strategy') {
    if (candidate.controlled.promptCompilerVersion !== 'seedance-compact-v1') {
      throw new SeedanceGoldenPreparationError(
        `${candidate.sceneId}/${candidate.shotId} candidate 必须使用 seedance-compact-v1`,
      )
    }
    if (baseline.controlled.promptCompilerVersion !== 'seedance-verbose-baseline-v1') {
      throw new SeedanceGoldenPreparationError(
        `${candidate.sceneId}/${candidate.shotId} baseline 必须使用 seedance-verbose-baseline-v1`,
      )
    }
    if (candidate.controlled.promptChecksum === baseline.controlled.promptChecksum) {
      throw new SeedanceGoldenPreparationError(
        `${candidate.sceneId}/${candidate.shotId} 的实际 Prompt checksum 未形成差异`,
      )
    }
  }
}

export async function prepareSeedanceGoldenDraft(input: {
  databasePath: string
  episodeId: string
  name: string
  comparisonAxis: SeedanceGoldenAxis
  pairs: readonly SeedanceGoldenJobPair[]
  now?: string
  candidateGetsA?: (caseIndex: number) => boolean
}): Promise<{
  manifest: SeedanceGoldenManifestDraft
  reviewSheet: SeedanceGoldenBlindReviewSheet
}> {
  if (!AXES.has(input.comparisonAxis)) throw new SeedanceGoldenPreparationError('comparisonAxis 无效')
  if (input.pairs.length < 6 || input.pairs.length > 12) {
    throw new SeedanceGoldenPreparationError('必须提供 6–12 组 A/B Job')
  }
  if (!input.name.trim() || input.name.length > 300) throw new SeedanceGoldenPreparationError('Golden 名称无效')
  const databasePath = resolve(input.databasePath)
  await access(databasePath)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const episode = database.prepare(`
      SELECT project_id, source_revision_id FROM episodes WHERE id = ?
    `).get(input.episodeId) as Record<string, unknown> | undefined
    if (!episode) throw new SeedanceGoldenPreparationError(`Episode ${input.episodeId} 不存在`)
    const currentRevisionId = string(episode.source_revision_id, `Episode ${input.episodeId}.sourceRevisionId`)
    const seenJobs = new Set<string>()
    const seenTasks = new Set<string>()
    const seenAssets = new Set<string>()
    const seenShots = new Set<string>()
    const cases: SeedanceGoldenManifestDraft['cases'] = []
    for (const [index, pair] of input.pairs.entries()) {
      if (pair.candidateJobId === pair.baselineJobId) {
        throw new SeedanceGoldenPreparationError(`第 ${index + 1} 组复用了同一个 Job`)
      }
      const [candidate, baseline] = await Promise.all([
        loadAuthorityVariant(database, databasePath, input.episodeId, currentRevisionId, pair.candidateJobId),
        loadAuthorityVariant(database, databasePath, input.episodeId, currentRevisionId, pair.baselineJobId),
      ])
      assertControlledPair(input.comparisonAxis, candidate, baseline)
      const shotKey = `${candidate.sceneId}\u0000${candidate.shotId}`
      if (seenShots.has(shotKey)) throw new SeedanceGoldenPreparationError(`镜头 ${candidate.sceneId}/${candidate.shotId} 被重复选择`)
      seenShots.add(shotKey)
      for (const variant of [candidate, baseline]) {
        if (seenJobs.has(variant.controlled.jobId)) throw new SeedanceGoldenPreparationError(`重复 Job ${variant.controlled.jobId}`)
        if (seenTasks.has(variant.controlled.providerTaskId)) throw new SeedanceGoldenPreparationError(`重复 Provider Task ${variant.controlled.providerTaskId}`)
        if (seenAssets.has(variant.controlled.outputAssetId)) throw new SeedanceGoldenPreparationError(`重复输出 Asset ${variant.controlled.outputAssetId}`)
        seenJobs.add(variant.controlled.jobId)
        seenTasks.add(variant.controlled.providerTaskId)
        seenAssets.add(variant.controlled.outputAssetId)
      }
      const candidateGetsA = input.candidateGetsA?.(index) ?? (randomBytes(1)[0]! & 1) === 0
      const candidateVariant: SeedanceGoldenDraftVariant = {
        id: `${candidate.shotId}-candidate-${candidate.controlled.jobId}`,
        blindLabel: candidateGetsA ? 'A' : 'B',
        role: 'candidate',
        ...candidate.controlled,
        review: reviewPlaceholder(),
      }
      const baselineVariant: SeedanceGoldenDraftVariant = {
        id: `${baseline.shotId}-baseline-${baseline.controlled.jobId}`,
        blindLabel: candidateGetsA ? 'B' : 'A',
        role: 'baseline',
        ...baseline.controlled,
        review: reviewPlaceholder(),
      }
      cases.push({
        sceneId: candidate.sceneId,
        shotId: candidate.shotId,
        variants: [candidateVariant, baselineVariant],
      })
    }
    const createdAt = input.now ?? new Date().toISOString()
    const manifest: SeedanceGoldenManifestDraft = {
      version: 1,
      name: input.name,
      episodeId: input.episodeId,
      comparisonAxis: input.comparisonAxis,
      createdAt,
      policy: {
        nonInferiorityMargin: 0.25,
        minimumCandidateScore: 3.5,
        maximumPerCaseRegression: 1,
      },
      cases,
    }
    const reviewSheet: SeedanceGoldenBlindReviewSheet = {
      version: 1,
      manifestName: input.name,
      episodeId: input.episodeId,
      comparisonAxis: input.comparisonAxis,
      reviewerId: '',
      reviewedAt: '',
      instructions: [
        '不要打开 evidence manifest；只按 A/B 标签完整播放每条视频。',
        '六项评分均填写 1–5 整数，播放未完成时保持 false，不能进入最终验证。',
        '本文件不含 candidate/baseline 身份；完成后由 finalize 工具合并回证据清单。',
      ],
      cases: cases.map((item) => ({
        sceneId: item.sceneId,
        shotId: item.shotId,
        variants: [...item.variants]
          .sort((left, right) => left.blindLabel.localeCompare(right.blindLabel))
          .map((variant) => ({
            blindLabel: variant.blindLabel,
            assetId: variant.outputAssetId,
            contentUrl: `/api/v1/assets/${encodeURIComponent(variant.outputAssetId)}/content`,
            playbackComplete: false,
            scores: Object.fromEntries(SEEDANCE_GOLDEN_METRICS.map((metric) => [metric, 0])) as Record<SeedanceGoldenMetric, 0>,
            notes: '',
          })),
      })),
    }
    return { manifest, reviewSheet }
  } finally {
    database.close()
  }
}

export async function inspectSeedanceGoldenCandidates(input: {
  databasePath: string
  episodeId: string
}): Promise<{
  episodeId: string
  sourceRevisionId: string
  eligible: Array<{
    jobId: string
    sceneId: string
    shotId: string
    providerTaskId: string
    outputAssetId: string
    resolution: '480p' | '720p' | '1080p'
    audioPolicy: 'silent' | 'sfx_only' | 'provider_audio'
    promptCompilerVersion: string
    referenceStrategy: string
    timingManifestFingerprint: string
    completedAt: string
  }>
  rejected: Array<{ jobId: string; reason: string }>
  providerSubmissions: 0
}> {
  const databasePath = resolve(input.databasePath)
  await access(databasePath)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const episode = database.prepare('SELECT source_revision_id FROM episodes WHERE id = ?').get(input.episodeId) as Record<string, unknown> | undefined
    if (!episode) throw new SeedanceGoldenPreparationError(`Episode ${input.episodeId} 不存在`)
    const sourceRevisionId = string(episode.source_revision_id, `Episode ${input.episodeId}.sourceRevisionId`)
    const rows = database.prepare(`
      SELECT id FROM generation_jobs
       WHERE episode_id = ? AND type = 'shot.video.generate' AND status = 'succeeded'
       ORDER BY completed_at DESC, id DESC
    `).all(input.episodeId) as Array<{ id: string }>
    const eligible: Awaited<ReturnType<typeof inspectSeedanceGoldenCandidates>>['eligible'] = []
    const rejected: Array<{ jobId: string; reason: string }> = []
    for (const row of rows) {
      try {
        const value = await loadAuthorityVariant(database, databasePath, input.episodeId, sourceRevisionId, row.id)
        eligible.push({
          jobId: value.controlled.jobId,
          sceneId: value.sceneId,
          shotId: value.shotId,
          providerTaskId: value.controlled.providerTaskId,
          outputAssetId: value.controlled.outputAssetId,
          resolution: value.controlled.resolution,
          audioPolicy: value.controlled.audioPolicy,
          promptCompilerVersion: value.controlled.promptCompilerVersion,
          referenceStrategy: value.controlled.referenceStrategy,
          timingManifestFingerprint: value.controlled.timingManifestFingerprint,
          completedAt: value.controlled.completedAt,
        })
      } catch (error) {
        rejected.push({
          jobId: row.id,
          reason: error instanceof Error ? error.message : '权威证据无效',
        })
      }
    }
    return {
      episodeId: input.episodeId,
      sourceRevisionId,
      eligible,
      rejected,
      providerSubmissions: 0,
    }
  } finally {
    database.close()
  }
}

export function parseSeedanceGoldenPair(value: string): SeedanceGoldenJobPair {
  const parts = value.split(',')
  if (parts.length !== 2 || parts.some((part) => !IDENTIFIER.test(part))) {
    throw new SeedanceGoldenPreparationError('--pair 必须使用 candidateJobId,baselineJobId')
  }
  return { candidateJobId: parts[0]!, baselineJobId: parts[1]! }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      database: { type: 'string', short: 'd', default: 'runtime/manju.sqlite' },
      episode: { type: 'string', short: 'e' },
      name: { type: 'string', short: 'n' },
      axis: { type: 'string', short: 'a' },
      pair: { type: 'string', multiple: true },
      output: { type: 'string', short: 'o' },
      'review-sheet': { type: 'string' },
      inspect: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (!values.episode) throw new SeedanceGoldenPreparationError('必须提供 --episode <id>')
  if (values.inspect) {
    process.stdout.write(`${JSON.stringify(await inspectSeedanceGoldenCandidates({
      databasePath: values.database!,
      episodeId: values.episode,
    }), null, 2)}\n`)
    return
  }
  if (!values.name) throw new SeedanceGoldenPreparationError('必须提供 --name <label>')
  if (!values.axis || !AXES.has(values.axis as SeedanceGoldenAxis)) {
    throw new SeedanceGoldenPreparationError('必须提供有效 --axis')
  }
  if (!values.output) throw new SeedanceGoldenPreparationError('必须提供 --output <manifest-draft.json>')
  if (!values['review-sheet']) throw new SeedanceGoldenPreparationError('必须提供 --review-sheet <blind-review.json>')
  const prepared = await prepareSeedanceGoldenDraft({
    databasePath: values.database!,
    episodeId: values.episode,
    name: values.name,
    comparisonAxis: values.axis as SeedanceGoldenAxis,
    pairs: (values.pair ?? []).map(parseSeedanceGoldenPair),
  })
  const manifestEncoded = `${JSON.stringify(prepared.manifest, null, 2)}\n`
  const reviewEncoded = `${JSON.stringify(prepared.reviewSheet, null, 2)}\n`
  await writeFile(values.output, manifestEncoded, { encoding: 'utf8', flag: 'wx' })
  try {
    await writeFile(values['review-sheet'], reviewEncoded, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    throw new SeedanceGoldenPreparationError(`盲审表写入失败；证据草稿已保留在 ${values.output}，请勿覆盖`)
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    manifestDraft: resolve(values.output),
    blindReviewSheet: resolve(values['review-sheet']),
    caseCount: prepared.manifest.cases.length,
    providerSubmissions: 0,
  }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Seedance Golden 草稿准备失败'}\n`)
    process.exitCode = 1
  })
}
