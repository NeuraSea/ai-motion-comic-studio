import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { ManjuDatabase } from './database.js'

export const ASSET_RETENTION_DAYS = 7
export const ASSET_RETENTION_POLICY_VERSION = 'asset-retention-v2'

const DEFAULT_CANDIDATE_LIMIT = 1_000
const MAX_CACHED_PLANS = 32
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024
const ELIGIBLE_INTERMEDIATE_SOURCES = ['generated', 'provider', 'seedance'] as const
const ELIGIBLE_INTERMEDIATE_SOURCE_SET = new Set<string>(ELIGIBLE_INTERMEDIATE_SOURCES)
const QUARANTINE_DIRECTORY_NAME = '.asset-retention-quarantine'
const JOURNAL_FILE_NAME = 'journal.json'

export type AssetRetentionErrorCode =
  | 'RETENTION_APPLY_UNAVAILABLE'
  | 'RETENTION_CONFIRMATION_INVALID'
  | 'RETENTION_PLAN_NOT_FOUND'
  | 'RETENTION_PLAN_DRIFT'
  | 'RETENTION_UNSAFE_PATH'
  | 'RETENTION_RECOVERY_REQUIRED'

export class AssetRetentionError extends Error {
  constructor(readonly code: AssetRetentionErrorCode, message: string) {
    super(message)
    this.name = 'AssetRetentionError'
  }
}

/** Test-only fault used to model process death without running compensation. */
export class AssetRetentionCrashSimulation extends Error {
  constructor(message = 'Simulated asset-retention process crash') {
    super(message)
    this.name = 'AssetRetentionCrashSimulation'
  }
}

export interface AssetRetentionCandidate {
  assetId: string
  projectId: string
  kind: string
  source: string
  status: string
  updatedAt: string
}

export interface ProtectedAssetRetentionCandidate extends AssetRetentionCandidate {
  references: string[]
}

export interface AssetRetentionPlan {
  policyVersion: typeof ASSET_RETENTION_POLICY_VERSION
  dryRun: true
  applyEnabled: boolean
  planFingerprint: string
  confirmationToken: string
  retentionDays: typeof ASSET_RETENTION_DAYS
  cutoff: string
  candidateLimit: number
  truncated: boolean
  policy: {
    eligibleSources: string[]
    excludedClasses: string[]
  }
  summary: {
    candidates: number
    deletable: number
    protected: number
  }
  deletable: AssetRetentionCandidate[]
  protected: ProtectedAssetRetentionCandidate[]
}

export interface AssetRetentionServiceOptions {
  now?: () => Date
  candidateLimit?: number
  runtimeDirectory?: string
  confirmationSecret?: Uint8Array
  onPhase?: (
    phase: 'journal-prepared' | 'asset-quarantined' | 'all-quarantined' | 'database-committed',
    context: { operationId: string; assetId?: string },
  ) => void | Promise<void>
}

export interface AssetRetentionApplyInput {
  planFingerprint: string
  confirmationToken: string
}

export interface AssetRetentionApplyResult {
  policyVersion: typeof ASSET_RETENTION_POLICY_VERSION
  dryRun: false
  planFingerprint: string
  operationId: string
  idempotent: boolean
  summary: {
    planned: number
    quarantined: number
    deleted: number
    cleaned: number
    cleanupPending: number
  }
  deletedAssetIds: string[]
  cleanupPendingAssetIds: string[]
}

interface InternalAssetRetentionCandidate extends AssetRetentionCandidate {
  filePath: string
  version: number
  checksum: string | null
}

interface CachedAssetRetentionPlan {
  plan: AssetRetentionPlan
  candidates: InternalAssetRetentionCandidate[]
  result?: AssetRetentionApplyResult
}

interface AssetRetentionJournalEntry {
  assetId: string
  sourceFilePath: string
  quarantineName: string
}

interface AssetRetentionJournal {
  version: 1
  operationId: string
  planFingerprint: string
  state: 'prepared' | 'quarantined' | 'database_committed' | 'cleanup_pending'
  entries: AssetRetentionJournalEntry[]
}

const REFERENCES_SQL = `
WITH candidate(asset_id) AS (VALUES (?))
SELECT reason FROM (
  SELECT 'characters.locked_asset_id' AS reason
    WHERE EXISTS (
      SELECT 1 FROM characters, candidate
       WHERE characters.locked_asset_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'character_visual_references.asset_id'
    WHERE EXISTS (
      SELECT 1 FROM character_visual_references, candidate
       WHERE character_visual_references.asset_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'locations.locked_asset_id'
    WHERE EXISTS (
      SELECT 1 FROM locations, candidate
       WHERE locations.locked_asset_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'props.locked_asset_id'
    WHERE EXISTS (
      SELECT 1 FROM props, candidate
       WHERE props.locked_asset_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'shots.storyboard_asset_id'
    WHERE EXISTS (
      SELECT 1 FROM shots, candidate
       WHERE shots.storyboard_asset_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'shots.video_asset_id'
    WHERE EXISTS (
      SELECT 1 FROM shots, candidate
       WHERE shots.video_asset_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'shot_media_review_decisions.asset_id'
    WHERE EXISTS (
      SELECT 1 FROM shot_media_review_decisions, candidate
       WHERE shot_media_review_decisions.asset_id = candidate.asset_id
          OR shot_media_review_decisions.previous_asset_id = candidate.asset_id
          OR shot_media_review_decisions.selected_asset_id = candidate.asset_id
          OR shot_media_review_decisions.cleared_video_asset_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'dialogue_lines.speech_asset_id'
    WHERE EXISTS (
      SELECT 1 FROM dialogue_lines, candidate
       WHERE dialogue_lines.speech_asset_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'production_asset_manifest_entries.asset_version_id'
    WHERE EXISTS (
      SELECT 1 FROM production_asset_manifest_entries, candidate
       WHERE production_asset_manifest_entries.asset_version_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'media_assets.parent_asset_id'
    WHERE EXISTS (
      SELECT 1 FROM media_assets, candidate
       WHERE media_assets.parent_asset_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'exports.output_asset_id'
    WHERE EXISTS (
      SELECT 1 FROM exports, candidate
       WHERE exports.output_asset_id = candidate.asset_id
    )
  UNION ALL
  SELECT 'generation_jobs.resource_id'
    WHERE EXISTS (
      SELECT 1 FROM generation_jobs, candidate
       WHERE generation_jobs.resource_id = candidate.asset_id
         AND lower(coalesce(generation_jobs.resource_type, '')) LIKE 'asset%'
    )
  UNION ALL
  SELECT 'projects.settings_json'
    WHERE EXISTS (
      SELECT 1 FROM projects, json_tree(projects.settings_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'episodes.metadata_json'
    WHERE EXISTS (
      SELECT 1 FROM episodes, json_tree(episodes.metadata_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'revisions.snapshot_json'
    WHERE EXISTS (
      SELECT 1 FROM revisions, json_tree(revisions.snapshot_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'characters.metadata_json'
    WHERE EXISTS (
      SELECT 1 FROM characters, json_tree(characters.metadata_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'locations.metadata_json'
    WHERE EXISTS (
      SELECT 1 FROM locations, json_tree(locations.metadata_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'props.metadata_json'
    WHERE EXISTS (
      SELECT 1 FROM props, json_tree(props.metadata_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'scenes.metadata_json'
    WHERE EXISTS (
      SELECT 1 FROM scenes, json_tree(scenes.metadata_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'shots.metadata_json'
    WHERE EXISTS (
      SELECT 1 FROM shots, json_tree(shots.metadata_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'dialogue_lines.metadata_json'
    WHERE EXISTS (
      SELECT 1 FROM dialogue_lines, json_tree(dialogue_lines.metadata_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'pipeline_runs.steps_json'
    WHERE EXISTS (
      SELECT 1 FROM pipeline_runs, json_tree(pipeline_runs.steps_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'pipeline_runs.error_json'
    WHERE EXISTS (
      SELECT 1 FROM pipeline_runs, json_tree(pipeline_runs.error_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'generation_jobs.input_json'
    WHERE EXISTS (
      SELECT 1 FROM generation_jobs, json_tree(generation_jobs.input_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'generation_jobs.provider_state_json'
    WHERE EXISTS (
      SELECT 1 FROM generation_jobs, json_tree(generation_jobs.provider_state_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'generation_jobs.progress_detail_json'
    WHERE EXISTS (
      SELECT 1 FROM generation_jobs, json_tree(generation_jobs.progress_detail_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'generation_jobs.output_json'
    WHERE EXISTS (
      SELECT 1 FROM generation_jobs, json_tree(generation_jobs.output_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'generation_jobs.error_json'
    WHERE EXISTS (
      SELECT 1 FROM generation_jobs, json_tree(generation_jobs.error_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'generation_jobs.cost_json'
    WHERE EXISTS (
      SELECT 1 FROM generation_jobs, json_tree(generation_jobs.cost_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'media_assets.generation_parameters_json'
    WHERE EXISTS (
      SELECT 1 FROM media_assets, json_tree(media_assets.generation_parameters_json) AS value, candidate
       WHERE media_assets.id <> candidate.asset_id
         AND value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'exports.timeline_snapshot_json'
    WHERE EXISTS (
      SELECT 1 FROM exports, json_tree(exports.timeline_snapshot_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'exports.specification_json'
    WHERE EXISTS (
      SELECT 1 FROM exports, json_tree(exports.specification_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'exports.error_json'
    WHERE EXISTS (
      SELECT 1 FROM exports, json_tree(exports.error_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'quality_reports.checks_json'
    WHERE EXISTS (
      SELECT 1 FROM quality_reports, json_tree(quality_reports.checks_json) AS value, candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
  UNION ALL
  SELECT 'timeline_document_revisions.snapshot_json'
    WHERE EXISTS (
      SELECT 1 FROM timeline_document_revisions,
                    json_tree(timeline_document_revisions.snapshot_json) AS value,
                    candidate
       WHERE value.type = 'text' AND value.atom = candidate.asset_id
    )
)
ORDER BY reason
`

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`Asset retention row is missing ${key}`)
  return value
}

function candidateFromRow(row: Record<string, unknown>): AssetRetentionCandidate {
  return {
    assetId: requiredText(row, 'id'),
    projectId: requiredText(row, 'project_id'),
    kind: requiredText(row, 'kind'),
    source: requiredText(row, 'source'),
    status: requiredText(row, 'status'),
    updatedAt: requiredText(row, 'updated_at'),
  }
}

function publicCandidate(candidate: InternalAssetRetentionCandidate): AssetRetentionCandidate {
  return {
    assetId: candidate.assetId,
    projectId: candidate.projectId,
    kind: candidate.kind,
    source: candidate.source,
    status: candidate.status,
    updatedAt: candidate.updatedAt,
  }
}

function internalCandidateFromRow(row: Record<string, unknown>): InternalAssetRetentionCandidate {
  const version = row.version
  const checksum = row.checksum
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new TypeError('Asset retention row is missing a valid version')
  }
  if (checksum !== null && typeof checksum !== 'string') {
    throw new TypeError('Asset retention row has an invalid checksum')
  }
  return {
    ...candidateFromRow(row),
    filePath: requiredText(row, 'file_path'),
    version,
    checksum,
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stablePlanFingerprint(input: {
  cutoff: string
  candidateLimit: number
  truncated: boolean
  candidates: InternalAssetRetentionCandidate[]
  protected: ProtectedAssetRetentionCandidate[]
}): string {
  return sha256(JSON.stringify({
    policyVersion: ASSET_RETENTION_POLICY_VERSION,
    retentionDays: ASSET_RETENTION_DAYS,
    cutoff: input.cutoff,
    candidateLimit: input.candidateLimit,
    truncated: input.truncated,
    candidates: input.candidates.map((candidate) => ({
      assetId: candidate.assetId,
      projectId: candidate.projectId,
      kind: candidate.kind,
      source: candidate.source,
      status: candidate.status,
      updatedAt: candidate.updatedAt,
      filePath: candidate.filePath,
      version: candidate.version,
      checksum: candidate.checksum,
    })),
    protected: input.protected.map((candidate) => ({
      assetId: candidate.assetId,
      references: candidate.references,
    })),
  }))
}

function clonePlan(plan: AssetRetentionPlan): AssetRetentionPlan {
  return {
    ...plan,
    policy: {
      eligibleSources: [...plan.policy.eligibleSources],
      excludedClasses: [...plan.policy.excludedClasses],
    },
    summary: { ...plan.summary },
    deletable: plan.deletable.map((candidate) => ({ ...candidate })),
    protected: plan.protected.map((candidate) => ({
      ...candidate,
      references: [...candidate.references],
    })),
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function validateStoredMediaPath(filePath: string): string[] {
  if (!filePath || filePath.includes('\0') || filePath.includes('\\') || isAbsolute(filePath)) {
    throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产保留清理拒绝无效的媒体路径')
  }
  const parts = filePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..') || parts[0] !== 'media') {
    throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产保留清理只允许隔离 media 目录中的文件')
  }
  return parts
}

async function requireSafeDirectory(path: string, parentRealPath?: string): Promise<string> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产保留清理目录不能是符号链接')
  }
  const actual = await realpath(path)
  if (parentRealPath && !isWithin(parentRealPath, actual)) {
    throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产保留清理目录越过运行目录边界')
  }
  return actual
}

async function requireSafeSourceFile(
  runtimeDirectory: string,
  mediaDirectory: string,
  filePath: string,
): Promise<string> {
  const parts = validateStoredMediaPath(filePath)
  const runtimeRealPath = await requireSafeDirectory(runtimeDirectory)
  const mediaRealPath = await requireSafeDirectory(mediaDirectory, runtimeRealPath)
  const lexicalPath = resolve(runtimeDirectory, ...parts)
  if (!isWithin(mediaDirectory, lexicalPath)) {
    throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产保留清理文件越过媒体目录边界')
  }
  let current = mediaDirectory
  for (const part of parts.slice(1, -1)) {
    current = resolve(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产保留清理拒绝包含符号链接的媒体路径')
    }
  }
  const info = await lstat(lexicalPath)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产保留清理只允许隔离普通媒体文件')
  }
  const actualPath = await realpath(lexicalPath)
  if (!isWithin(mediaRealPath, actualPath)) {
    throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产保留清理文件指向媒体目录之外')
  }
  return lexicalPath
}

function isEligibleRow(
  row: Record<string, unknown> | undefined,
  candidate: InternalAssetRetentionCandidate,
  cutoff: string,
): boolean {
  if (!row) return false
  const source = row.source
  const kind = row.kind
  const updatedAt = row.updated_at
  return row.id === candidate.assetId
    && row.project_id === candidate.projectId
    && row.file_path === candidate.filePath
    && row.version === candidate.version
    && row.checksum === candidate.checksum
    && row.status === candidate.status
    && typeof source === 'string'
    && ELIGIBLE_INTERMEDIATE_SOURCE_SET.has(source.toLowerCase())
    && source === candidate.source
    && typeof kind === 'string'
    && kind === candidate.kind
    && !isProtectedOutputKind(kind)
    && typeof updatedAt === 'string'
    && updatedAt === candidate.updatedAt
    && Number.isFinite(Date.parse(updatedAt))
    && Date.parse(updatedAt) <= Date.parse(cutoff)
}

function isProtectedOutputKind(kind: string): boolean {
  const normalized = kind.toLowerCase()
  return normalized === 'export'
    || normalized === 'render'
    || normalized === 'final.video'
    || normalized.startsWith('export.')
    || normalized.endsWith('.export')
    || normalized.startsWith('render.')
    || normalized.endsWith('.render')
}

function requireJournal(value: unknown): AssetRetentionJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssetRetentionError('RETENTION_RECOVERY_REQUIRED', '资产隔离日志格式无效')
  }
  const journal = value as Record<string, unknown>
  if (Object.keys(journal).some((key) => ![
    'version',
    'operationId',
    'planFingerprint',
    'state',
    'entries',
  ].includes(key))) {
    throw new AssetRetentionError('RETENTION_RECOVERY_REQUIRED', '资产隔离日志包含未知字段')
  }
  const validStates = new Set(['prepared', 'quarantined', 'database_committed', 'cleanup_pending'])
  if (journal.version !== 1
    || typeof journal.operationId !== 'string'
    || !/^retention-[a-f0-9]{24}$/.test(journal.operationId)
    || typeof journal.planFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(journal.planFingerprint)
    || typeof journal.state !== 'string'
    || !validStates.has(journal.state)
    || !Array.isArray(journal.entries)) {
    throw new AssetRetentionError('RETENTION_RECOVERY_REQUIRED', '资产隔离日志字段无效')
  }
  const entries = journal.entries.map((entry): AssetRetentionJournalEntry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AssetRetentionError('RETENTION_RECOVERY_REQUIRED', '资产隔离日志条目无效')
    }
    const record = entry as Record<string, unknown>
    if (Object.keys(record).some((key) => ![
      'assetId',
      'sourceFilePath',
      'quarantineName',
    ].includes(key))) {
      throw new AssetRetentionError('RETENTION_RECOVERY_REQUIRED', '资产隔离日志条目包含未知字段')
    }
    if (typeof record.assetId !== 'string'
      || record.assetId.length < 1
      || record.assetId.length > 200
      || typeof record.sourceFilePath !== 'string'
      || typeof record.quarantineName !== 'string'
      || !/^asset-[0-9]{4}-[a-f0-9]{16}\.bin$/.test(record.quarantineName)) {
      throw new AssetRetentionError('RETENTION_RECOVERY_REQUIRED', '资产隔离日志条目字段无效')
    }
    validateStoredMediaPath(record.sourceFilePath)
    return {
      assetId: record.assetId,
      sourceFilePath: record.sourceFilePath,
      quarantineName: record.quarantineName,
    }
  })
  if (entries.length > 10_000
    || new Set(entries.map((entry) => entry.assetId)).size !== entries.length
    || new Set(entries.map((entry) => entry.sourceFilePath)).size !== entries.length
    || new Set(entries.map((entry) => entry.quarantineName)).size !== entries.length
    || journal.operationId !== `retention-${journal.planFingerprint.slice(0, 24)}`) {
    throw new AssetRetentionError('RETENTION_RECOVERY_REQUIRED', '资产隔离日志条目不唯一或指纹不匹配')
  }
  return {
    version: 1,
    operationId: journal.operationId,
    planFingerprint: journal.planFingerprint,
    state: journal.state as AssetRetentionJournal['state'],
    entries,
  }
}

async function readJournalText(path: string): Promise<string> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size < 2 || info.size > MAX_JOURNAL_BYTES) {
    throw new AssetRetentionError('RETENTION_RECOVERY_REQUIRED', '资产隔离日志不是安全的普通文件')
  }
  return readFile(path, 'utf8')
}

export class AssetRetentionService {
  private readonly now: () => Date
  private readonly candidateLimit: number
  private readonly runtimeDirectory: string | undefined
  private readonly mediaDirectory: string | undefined
  private readonly quarantineDirectory: string | undefined
  private readonly confirmationSecret: Buffer
  private readonly onPhase: AssetRetentionServiceOptions['onPhase']
  private readonly plans = new Map<string, CachedAssetRetentionPlan>()
  private readonly inFlight = new Map<string, Promise<AssetRetentionApplyResult>>()
  private exclusiveTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly database: ManjuDatabase,
    options: AssetRetentionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT
    this.runtimeDirectory = options.runtimeDirectory ? resolve(options.runtimeDirectory) : undefined
    this.mediaDirectory = this.runtimeDirectory ? resolve(this.runtimeDirectory, 'media') : undefined
    this.quarantineDirectory = this.runtimeDirectory
      ? resolve(this.runtimeDirectory, QUARANTINE_DIRECTORY_NAME)
      : undefined
    this.confirmationSecret = Buffer.from(options.confirmationSecret ?? randomBytes(32))
    this.onPhase = options.onPhase
    if (!Number.isInteger(this.candidateLimit) || this.candidateLimit < 1 || this.candidateLimit > 10_000) {
      throw new RangeError('candidateLimit must be an integer from 1 to 10000')
    }
    if (this.confirmationSecret.byteLength < 32) {
      throw new RangeError('confirmationSecret must contain at least 32 bytes')
    }
  }

  plan(): AssetRetentionPlan {
    const now = this.now()
    if (!Number.isFinite(now.getTime())) throw new TypeError('Asset retention clock returned an invalid date')
    const cutoff = new Date(now.getTime() - ASSET_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString()
    const rows = this.database.withSql((sql) => sql.all(`
      SELECT id, project_id, kind, source, status, updated_at, file_path, version, checksum
        FROM media_assets
       WHERE file_path IS NOT NULL
         AND julianday(updated_at) <= julianday(?)
         AND lower(source) IN ('generated', 'provider', 'seedance')
         AND lower(kind) NOT LIKE 'export.%'
         AND lower(kind) NOT LIKE '%.export'
         AND lower(kind) NOT LIKE 'render.%'
         AND lower(kind) NOT LIKE '%.render'
         AND lower(kind) NOT IN ('export', 'render', 'final.video')
       ORDER BY updated_at ASC, id ASC
       LIMIT ?
    `, cutoff, this.candidateLimit + 1))
    const truncated = rows.length > this.candidateLimit
    const candidates = rows.slice(0, this.candidateLimit).map(internalCandidateFromRow)
    const deletable: AssetRetentionCandidate[] = []
    const internalDeletable: InternalAssetRetentionCandidate[] = []
    const protectedCandidates: ProtectedAssetRetentionCandidate[] = []
    for (const candidate of candidates) {
      const references = this.database.withSql((sql) => sql.all(
        REFERENCES_SQL,
        candidate.assetId,
      )).map((row) => requiredText(row, 'reason'))
      if (references.length > 0) {
        protectedCandidates.push({ ...publicCandidate(candidate), references })
      } else {
        deletable.push(publicCandidate(candidate))
        internalDeletable.push(candidate)
      }
    }
    const planFingerprint = stablePlanFingerprint({
      cutoff,
      candidateLimit: this.candidateLimit,
      truncated,
      candidates,
      protected: protectedCandidates,
    })
    const confirmationToken = createHmac('sha256', this.confirmationSecret)
      .update(`apply:${planFingerprint}`)
      .digest('hex')
    const plan: AssetRetentionPlan = {
      policyVersion: ASSET_RETENTION_POLICY_VERSION,
      dryRun: true,
      applyEnabled: this.runtimeDirectory !== undefined && internalDeletable.length > 0,
      planFingerprint,
      confirmationToken,
      retentionDays: ASSET_RETENTION_DAYS,
      cutoff,
      candidateLimit: this.candidateLimit,
      truncated,
      policy: {
        eligibleSources: [...ELIGIBLE_INTERMEDIATE_SOURCES],
        excludedClasses: [
          'user-upload',
          'legacy-or-import',
          'renderer-or-export',
          'newer-than-seven-days',
          'database-row-without-local-file',
        ],
      },
      summary: {
        candidates: candidates.length,
        deletable: deletable.length,
        protected: protectedCandidates.length,
      },
      deletable,
      protected: protectedCandidates,
    }
    // Preserve the same cached object while an identical fingerprint is being
    // applied. A concurrent dry-run must not erase its eventual idempotency
    // receipt merely because the database commit has not happened yet.
    if (!this.plans.has(planFingerprint)) {
      this.plans.set(planFingerprint, {
        plan: clonePlan(plan),
        candidates: internalDeletable.map((candidate) => ({ ...candidate })),
      })
    }
    while (this.plans.size > MAX_CACHED_PLANS) {
      const oldest = this.plans.keys().next().value as string | undefined
      if (!oldest) break
      this.plans.delete(oldest)
    }
    return clonePlan(plan)
  }

  async recover(): Promise<{ operations: number; restored: number; cleaned: number }> {
    return this.withExclusive(() => this.recoverUnlocked())
  }

  private async recoverUnlocked(): Promise<{ operations: number; restored: number; cleaned: number }> {
    if (!this.runtimeDirectory || !this.mediaDirectory || !this.quarantineDirectory) {
      return { operations: 0, restored: 0, cleaned: 0 }
    }
    const rootInfo = await lstat(this.quarantineDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!rootInfo) return { operations: 0, restored: 0, cleaned: 0 }
    const runtimeRealPath = await requireSafeDirectory(this.runtimeDirectory)
    await requireSafeDirectory(this.mediaDirectory, runtimeRealPath)
    await requireSafeDirectory(this.quarantineDirectory, runtimeRealPath)
    const children = await readdir(this.quarantineDirectory, { withFileTypes: true })
    let operations = 0
    let restored = 0
    let cleaned = 0
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink() || !/^retention-[a-f0-9]{24}$/.test(child.name)) {
        throw new AssetRetentionError(
          'RETENTION_RECOVERY_REQUIRED',
          '资产隔离目录包含无法自动验证的条目，已停止恢复',
        )
      }
      const operationDirectory = resolve(this.quarantineDirectory, child.name)
      const recovered = await this.recoverOperation(operationDirectory)
      operations += 1
      restored += recovered.restored
      cleaned += recovered.cleaned
    }
    return { operations, restored, cleaned }
  }

  async apply(input: AssetRetentionApplyInput): Promise<AssetRetentionApplyResult> {
    if (!this.runtimeDirectory || !this.mediaDirectory || !this.quarantineDirectory) {
      throw new AssetRetentionError(
        'RETENTION_APPLY_UNAVAILABLE',
        '资产保留清理未配置运行目录，只能执行 dry-run',
      )
    }
    if (!/^[a-f0-9]{64}$/.test(input.planFingerprint)
      || !/^[a-f0-9]{64}$/.test(input.confirmationToken)) {
      throw new AssetRetentionError('RETENTION_CONFIRMATION_INVALID', '资产保留计划确认信息格式无效')
    }
    const cached = this.plans.get(input.planFingerprint)
    if (!cached) {
      throw new AssetRetentionError(
        'RETENTION_PLAN_NOT_FOUND',
        '资产保留计划不存在、已过期或来自另一次服务启动；请重新 dry-run',
      )
    }
    const expectedToken = Buffer.from(cached.plan.confirmationToken, 'hex')
    const providedToken = Buffer.from(input.confirmationToken, 'hex')
    if (expectedToken.byteLength !== providedToken.byteLength
      || !timingSafeEqual(expectedToken, providedToken)) {
      throw new AssetRetentionError('RETENTION_CONFIRMATION_INVALID', '资产保留计划确认令牌不匹配')
    }
    if (!cached.plan.applyEnabled) {
      throw new AssetRetentionError('RETENTION_APPLY_UNAVAILABLE', '当前保留计划没有可安全清理的资产')
    }
    if (cached.result) return this.asIdempotent(cached.result)
    const running = this.inFlight.get(input.planFingerprint)
    if (running) return this.asIdempotent(await running)
    const promise = this.withExclusive(async () => {
      await this.recoverUnlocked()
      if (cached.result) return this.asIdempotent(cached.result)
      return this.applyCachedPlan(cached)
    })
    this.inFlight.set(input.planFingerprint, promise)
    try {
      const result = await promise
      cached.result = this.cloneResult(result, false)
      return this.cloneResult(result, false)
    } finally {
      this.inFlight.delete(input.planFingerprint)
    }
  }

  private asIdempotent(result: AssetRetentionApplyResult): AssetRetentionApplyResult {
    return this.cloneResult(result, true)
  }

  private async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveTail
    let release!: () => void
    this.exclusiveTail = new Promise<void>((resolveLock) => { release = resolveLock })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private cloneResult(
    result: AssetRetentionApplyResult,
    idempotent: boolean,
  ): AssetRetentionApplyResult {
    return {
      ...result,
      idempotent,
      summary: { ...result.summary },
      deletedAssetIds: [...result.deletedAssetIds],
      cleanupPendingAssetIds: [...result.cleanupPendingAssetIds],
    }
  }

  private async emitPhase(
    phase: Parameters<NonNullable<AssetRetentionServiceOptions['onPhase']>>[0],
    context: { operationId: string; assetId?: string },
  ): Promise<void> {
    await this.onPhase?.(phase, context)
  }

  private async ensureQuarantineRoot(): Promise<void> {
    if (!this.runtimeDirectory || !this.mediaDirectory || !this.quarantineDirectory) {
      throw new AssetRetentionError('RETENTION_APPLY_UNAVAILABLE', '资产保留清理未配置运行目录')
    }
    const runtimeRealPath = await requireSafeDirectory(this.runtimeDirectory)
    await requireSafeDirectory(this.mediaDirectory, runtimeRealPath)
    await mkdir(this.quarantineDirectory, { recursive: true, mode: 0o700 })
    await requireSafeDirectory(this.quarantineDirectory, runtimeRealPath)
  }

  private operationDirectory(operationId: string): string {
    if (!this.quarantineDirectory || !/^retention-[a-f0-9]{24}$/.test(operationId)) {
      throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产隔离操作 ID 无效')
    }
    const path = resolve(this.quarantineDirectory, operationId)
    if (!isWithin(this.quarantineDirectory, path)) {
      throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产隔离操作目录越界')
    }
    return path
  }

  private async writeJournal(operationDirectory: string, journal: AssetRetentionJournal): Promise<void> {
    const journalPath = resolve(operationDirectory, JOURNAL_FILE_NAME)
    const temporaryPath = resolve(
      operationDirectory,
      `.journal-${randomBytes(12).toString('hex')}.tmp`,
    )
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, journalPath)
  }

  private async removeFinishedOperationDirectory(operationDirectory: string): Promise<void> {
    const children = await readdir(operationDirectory, { withFileTypes: true })
    for (const child of children) {
      if (child.isSymbolicLink() || !child.isFile()
        || (child.name !== JOURNAL_FILE_NAME && !/^\.journal-[a-f0-9]{24}\.tmp$/.test(child.name))) {
        throw new AssetRetentionError(
          'RETENTION_RECOVERY_REQUIRED',
          '资产隔离操作目录包含未知条目，拒绝递归删除',
        )
      }
    }
    for (const child of children) await rm(resolve(operationDirectory, child.name), { force: true })
    await rmdir(operationDirectory)
  }

  private assertCandidatesCurrent(
    candidates: InternalAssetRetentionCandidate[],
    cutoff: string,
    deleteRows: boolean,
  ): void {
    this.database.transaction(() => {
      for (const candidate of candidates) {
        const row = this.database.withSql((sql) => sql.get(`
          SELECT id, project_id, kind, source, status, updated_at, file_path, version, checksum
            FROM media_assets
           WHERE id = ?
        `, candidate.assetId))
        if (!isEligibleRow(row, candidate, cutoff)) {
          throw new AssetRetentionError(
            'RETENTION_PLAN_DRIFT',
            `资产 ${candidate.assetId} 在计划后发生变化，未执行清理`,
          )
        }
        const references = this.database.withSql((sql) => sql.all(
          REFERENCES_SQL,
          candidate.assetId,
        ))
        if (references.length > 0) {
          throw new AssetRetentionError(
            'RETENTION_PLAN_DRIFT',
            `资产 ${candidate.assetId} 在计划后新增引用，未执行清理`,
          )
        }
      }
      if (deleteRows) {
        for (const candidate of candidates) {
          const deleted = this.database.withSql((sql) => sql.run(
            'DELETE FROM media_assets WHERE id = ?',
            candidate.assetId,
          )).changes
          if (deleted !== 1) {
            throw new AssetRetentionError(
              'RETENTION_PLAN_DRIFT',
              `资产 ${candidate.assetId} 未能按计划删除`,
            )
          }
        }
      }
    })
  }

  private async applyCachedPlan(cached: CachedAssetRetentionPlan): Promise<AssetRetentionApplyResult> {
    if (!this.runtimeDirectory || !this.mediaDirectory) {
      throw new AssetRetentionError('RETENTION_APPLY_UNAVAILABLE', '资产保留清理未配置运行目录')
    }
    await this.ensureQuarantineRoot()
    this.assertCandidatesCurrent(cached.candidates, cached.plan.cutoff, false)
    const operationId = `retention-${cached.plan.planFingerprint.slice(0, 24)}`
    const operationDirectory = this.operationDirectory(operationId)
    const sources = await Promise.all(cached.candidates.map((candidate) => (
      requireSafeSourceFile(this.runtimeDirectory!, this.mediaDirectory!, candidate.filePath)
    )))
    await mkdir(operationDirectory, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        throw new AssetRetentionError(
          'RETENTION_RECOVERY_REQUIRED',
          '同一资产保留计划仍有隔离操作待恢复',
        )
      }
      throw error
    })
    const entries = cached.candidates.map((candidate, index): AssetRetentionJournalEntry => ({
      assetId: candidate.assetId,
      sourceFilePath: candidate.filePath,
      quarantineName: `asset-${String(index).padStart(4, '0')}-${sha256(candidate.assetId).slice(0, 16)}.bin`,
    }))
    const journal: AssetRetentionJournal = {
      version: 1,
      operationId,
      planFingerprint: cached.plan.planFingerprint,
      state: 'prepared',
      entries,
    }
    try {
      await this.writeJournal(operationDirectory, journal)
    } catch (error) {
      try {
        await this.removeFinishedOperationDirectory(operationDirectory)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '无法持久化资产隔离日志，操作目录需要人工检查')
      }
      throw error
    }
    let databaseCommitted = false
    try {
      await this.emitPhase('journal-prepared', { operationId })
      for (const [index, entry] of entries.entries()) {
        const quarantinePath = resolve(operationDirectory, entry.quarantineName)
        const currentSource = await requireSafeSourceFile(
          this.runtimeDirectory,
          this.mediaDirectory,
          entry.sourceFilePath,
        )
        if (currentSource !== sources[index]) {
          throw new AssetRetentionError('RETENTION_PLAN_DRIFT', `资产 ${entry.assetId} 的文件路径发生变化`)
        }
        await rename(currentSource, quarantinePath)
        await this.emitPhase('asset-quarantined', { operationId, assetId: entry.assetId })
      }
      journal.state = 'quarantined'
      await this.writeJournal(operationDirectory, journal)
      await this.emitPhase('all-quarantined', { operationId })
      // BEGIN IMMEDIATE plus a second exact row/reference check makes the
      // destructive decision atomic with the index deletion. Any drift rolls
      // the whole batch back while every byte is still recoverable.
      this.assertCandidatesCurrent(cached.candidates, cached.plan.cutoff, true)
      databaseCommitted = true
      journal.state = 'database_committed'
      await this.writeJournal(operationDirectory, journal)
      await this.emitPhase('database-committed', { operationId })
    } catch (error) {
      if (error instanceof AssetRetentionCrashSimulation) throw error
      // Once SQLite committed, the authoritative rows are gone and restoring
      // bytes would create unindexed or misleading media. Continue the safe
      // physical cleanup using the already durable pre-commit journal; a later
      // recovery pass can finish anything the filesystem still refuses.
      if (databaseCommitted) {
        journal.state = 'database_committed'
      } else {
        try {
          await this.recoverOperation(operationDirectory)
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            '资产保留清理失败，且隔离文件需要人工恢复',
          )
        }
        throw error
      }
    }

    const cleanupPendingAssetIds: string[] = []
    let cleaned = 0
    for (const entry of entries) {
      const quarantinePath = resolve(operationDirectory, entry.quarantineName)
      try {
        const info = await lstat(quarantinePath)
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '隔离文件不再是普通文件')
        }
        await rm(quarantinePath)
        cleaned += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          cleaned += 1
        } else {
          cleanupPendingAssetIds.push(entry.assetId)
        }
      }
    }
    if (cleanupPendingAssetIds.length === 0) {
      await this.removeFinishedOperationDirectory(operationDirectory)
    } else {
      journal.state = 'cleanup_pending'
      await this.writeJournal(operationDirectory, journal)
    }
    return {
      policyVersion: ASSET_RETENTION_POLICY_VERSION,
      dryRun: false,
      planFingerprint: cached.plan.planFingerprint,
      operationId,
      idempotent: false,
      summary: {
        planned: entries.length,
        quarantined: entries.length,
        deleted: entries.length,
        cleaned,
        cleanupPending: cleanupPendingAssetIds.length,
      },
      deletedAssetIds: entries.map((entry) => entry.assetId),
      cleanupPendingAssetIds,
    }
  }

  private async recoverOperation(
    operationDirectory: string,
  ): Promise<{ restored: number; cleaned: number }> {
    if (!this.runtimeDirectory || !this.mediaDirectory || !this.quarantineDirectory) {
      throw new AssetRetentionError('RETENTION_APPLY_UNAVAILABLE', '资产保留恢复未配置运行目录')
    }
    if (!isWithin(this.quarantineDirectory, operationDirectory)) {
      throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产隔离恢复目录越界')
    }
    const operationInfo = await lstat(operationDirectory)
    if (operationInfo.isSymbolicLink() || !operationInfo.isDirectory()) {
      throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产隔离操作目录无效')
    }
    const journalPath = resolve(operationDirectory, JOURNAL_FILE_NAME)
    let journalText: string
    try {
      journalText = await readJournalText(journalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const children = await readdir(operationDirectory, { withFileTypes: true })
      if (children.length === 0) {
        // The final cleanup step removes the journal immediately before the
        // now-empty directory. A process death in that tiny window is safe to
        // finish without inventing any asset state.
        await rmdir(operationDirectory)
        return { restored: 0, cleaned: 0 }
      }
      const temporaryJournals = children.filter((child) => (
        child.isFile()
        && !child.isSymbolicLink()
        && /^\.journal-[a-f0-9]{24}\.tmp$/.test(child.name)
      ))
      if (temporaryJournals.length !== 1 || children.length !== 1) {
        throw new AssetRetentionError(
          'RETENTION_RECOVERY_REQUIRED',
          '资产隔离日志缺失且操作目录并非空目录，拒绝猜测恢复状态',
        )
      }
      journalText = await readJournalText(resolve(operationDirectory, temporaryJournals[0].name))
    }
    let journal: AssetRetentionJournal
    try {
      journal = requireJournal(JSON.parse(journalText))
    } catch (error) {
      if (error instanceof AssetRetentionError) throw error
      throw new AssetRetentionError('RETENTION_RECOVERY_REQUIRED', '资产隔离日志不是有效 JSON')
    }
    if (operationDirectory !== this.operationDirectory(journal.operationId)) {
      throw new AssetRetentionError('RETENTION_RECOVERY_REQUIRED', '资产隔离日志与目录不匹配')
    }
    let restored = 0
    let cleaned = 0
    for (const entry of journal.entries) {
      const sourcePath = resolve(this.runtimeDirectory, ...validateStoredMediaPath(entry.sourceFilePath))
      const quarantinePath = resolve(operationDirectory, entry.quarantineName)
      if (!isWithin(operationDirectory, quarantinePath)) {
        throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '隔离文件路径越界')
      }
      const [sourceInfo, quarantineInfo] = await Promise.all([
        lstat(sourcePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error)),
        lstat(quarantinePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error)),
      ])
      if (sourceInfo?.isSymbolicLink() || (sourceInfo && !sourceInfo.isFile())
        || quarantineInfo?.isSymbolicLink() || (quarantineInfo && !quarantineInfo.isFile())) {
        throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产隔离恢复拒绝符号链接或非普通文件')
      }
      const row = this.database.getMediaAsset(entry.assetId)
      if (row) {
        if (row.filePath !== entry.sourceFilePath) {
          throw new AssetRetentionError(
            'RETENTION_RECOVERY_REQUIRED',
            `资产 ${entry.assetId} 的索引路径在隔离后发生变化，拒绝猜测恢复位置`,
          )
        }
        if (sourceInfo && quarantineInfo) {
          throw new AssetRetentionError(
            'RETENTION_RECOVERY_REQUIRED',
            `资产 ${entry.assetId} 的原路径与隔离路径同时存在，拒绝覆盖`,
          )
        }
        if (!sourceInfo && !quarantineInfo) {
          throw new AssetRetentionError(
            'RETENTION_RECOVERY_REQUIRED',
            `资产 ${entry.assetId} 的索引仍存在但文件丢失`,
          )
        }
        if (quarantineInfo) {
          const parts = validateStoredMediaPath(entry.sourceFilePath)
          let current = this.mediaDirectory
          for (const part of parts.slice(1, -1)) {
            current = resolve(current, part)
            const info = await lstat(current)
            if (info.isSymbolicLink() || !info.isDirectory()) {
              throw new AssetRetentionError('RETENTION_UNSAFE_PATH', '资产恢复目标包含符号链接')
            }
          }
          await rename(quarantinePath, sourcePath)
          restored += 1
        }
      } else {
        if (sourceInfo) {
          throw new AssetRetentionError(
            'RETENTION_RECOVERY_REQUIRED',
            `资产 ${entry.assetId} 的索引已删除但原文件重新出现，拒绝自动删除`,
          )
        }
        if (quarantineInfo) {
          await rm(quarantinePath)
          cleaned += 1
        }
      }
    }
    await this.removeFinishedOperationDirectory(operationDirectory)
    return { restored, cleaned }
  }
}
