import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import type { ManjuDatabase } from './database.js'
import {
  currentMediaAuthority,
  timelineMediaAuthorityReceipt,
} from './media-authority.js'
import {
  ExportRenderError,
  validateExportRenderSemantics,
} from './export-render.js'
import { RenderSemanticPlanError } from '../apps/opencut-editor/src/render-semantic-plan.js'
import { canonicalizeOpenCutTimelineDocument } from '../apps/opencut-editor/src/canonical-timeline-codec.js'
import {
  serializeTimelineDocument,
  TimelineDocumentError,
  TimelineDocumentService,
  type TimelineDocumentSnapshot,
} from './timeline-documents.js'
import type {
  TimelineAutomaticEditReceipt,
  TimelineMaterializationService,
} from './timeline-materialization.js'
import type { JsonObject, JsonValue } from './types.js'

export type TimelineAutoEditRisk = 'safe' | 'confirmation-required' | 'blocked'
export type TimelineAutoEditDiagnosticSeverity = 'info' | 'warning' | 'error'

export interface TimelineAutoEditDiagnostic {
  code: string
  severity: TimelineAutoEditDiagnosticSeverity
  message: string
  elementIds: string[]
}

export interface TimelineAutoEditProposal {
  sourceRevisionId: string | null
  schemaVersion: number
  upstreamCommit: string
  strategy: string
  executor: string
  /** Stable semantic hash emitted by the server-owned OpenCut planner. */
  planHash: string
  risk: TimelineAutoEditRisk
  diagnostics: TimelineAutoEditDiagnostic[]
  operations: TimelineAutomaticEditReceipt['operations']
  changedElementIds: string[]
  document: JsonObject
}

export interface TimelineAutoEditPlanner {
  preview(input: {
    projectId: string
    episodeId: string
    goal: 'exportable'
    policy: 'safe'
    base: TimelineDocumentSnapshot
  }): TimelineAutoEditProposal
}

function blockedSemanticDiagnostic(error: ExportRenderError): TimelineAutoEditDiagnostic {
  const semantic = error.cause instanceof RenderSemanticPlanError ? error.cause : null
  const path = semantic?.path ?? ''
  if (semantic?.message.includes('visual clips must form one contiguous, non-overlapping sequence')) {
    return {
      code: 'UNSAFE_VISUAL_GAP_OR_OVERLAP',
      severity: 'error',
      message: '视觉轨存在空隙或重叠；正式导出只接受连续硬切，安全策略不会猜测应删除、移动或填充哪个画面。',
      elementIds: [],
    }
  }
  if (path.includes('.tracks.audio[')
    || semantic?.message.includes('audio clip exceeds the visual duration')) {
    return {
      code: 'UNSAFE_AUDIO_OUT_OF_BOUNDS',
      severity: 'error',
      message: `音频轨仍不可安全导出（可能是 BGM、SFX 或非托管音频越界）；安全策略不会擅自截断或移动它。${error.message}`,
      elementIds: [],
    }
  }
  if (path.includes('.tracks.overlay[')
    || semantic?.message.includes('subtitle cue exceeds the visual duration')
    || semantic?.message.includes('overlapping subtitle cues are ambiguous')) {
    return {
      code: 'UNSAFE_SUBTITLE_TIMING',
      severity: 'error',
      message: `字幕轨仍不可安全导出（可能是非托管字幕越界或重叠）；安全策略不会擅自改写字幕。${error.message}`,
      elementIds: [],
    }
  }
  return {
    code: `EXPORT_SEMANTIC_${error.code}`,
    severity: 'error',
    message: `自动剪辑候选仍未通过正式导出语义校验，且安全策略不能自动修复：${error.message}`,
    elementIds: [],
  }
}

/** Bridge the generic persistence service to the pinned OpenCut planner. */
export function createTimelineMaterializationAutoEditPlanner(
  materialization: TimelineMaterializationService,
  database: ManjuDatabase,
): TimelineAutoEditPlanner {
  return {
    preview(input) {
      const candidate = materialization.planAutomaticEdit({
        projectId: input.projectId,
        episodeId: input.episodeId,
        expectedRevisionId: input.base.revision.id,
      })
      const receipt = candidate.receipt
      const operations = receipt?.operations ?? []
      const diagnostic = (
        code: string,
        count: number,
        reason: string,
        message: string,
      ): TimelineAutoEditDiagnostic | null => count > 0 ? {
        code,
        severity: 'warning',
        message,
        elementIds: operations
          .filter((operation) => operation.reason === reason)
          .map((operation) => operation.elementId),
      } : null
      const diagnostics = [
        diagnostic(
          'MANAGED_DIALOGUE_REFLOW',
          candidate.diagnostics.managedDialogueOperations,
          'reflow-managed-dialogue-in-story-order',
          `需按剧本顺序重排 ${candidate.diagnostics.managedDialogueOperations} 个托管对白片段`,
        ),
        diagnostic(
          'MANAGED_SUBTITLE_SYNC',
          candidate.diagnostics.managedSubtitleOperations,
          'synchronize-managed-subtitle',
          `需同步 ${candidate.diagnostics.managedSubtitleOperations} 个托管字幕片段`,
        ),
        diagnostic(
          'MANAGED_VISUAL_AUDIO_CONFORM',
          candidate.diagnostics.managedVisualTailOperations,
          'extend-managed-visual-tail',
          `需按逐镜实测语音包络调整并顺延 ${candidate.diagnostics.managedVisualTailOperations} 个托管画面`,
        ),
        diagnostic(
          'MANAGED_SHORT_VIDEO_SAME_SHOT_IMAGE_HOLD',
          candidate.diagnostics.managedShortVideoFillOperations,
          'fill-short-managed-video-with-same-shot-image',
          `需将 ${candidate.diagnostics.managedShortVideoFillOperations} 个短视频补到原剪辑点：播完源视频后仅延长同镜已锁定分镜图`,
        ),
      ].filter((item): item is TimelineAutoEditDiagnostic => item !== null)
      let risk: TimelineAutoEditRisk = 'safe'
      let semanticOutcome: JsonValue
      try {
        const semanticPlan = validateExportRenderSemantics(database, {
          projectId: input.projectId,
          episodeId: input.episodeId,
          timelineDocumentId: candidate.base.timelineDocument.id,
          timelineRevisionId: candidate.base.revision.id,
          storyRevisionId: candidate.sourceRevisionId,
          document: candidate.document,
        })
        semanticOutcome = {
          status: 'exportable',
          semanticPlanHash: sha256(JSON.stringify(semanticPlan)),
        }
      } catch (error) {
        if (!(error instanceof ExportRenderError)) throw error
        risk = 'blocked'
        const blocked = blockedSemanticDiagnostic(error)
        diagnostics.push(blocked)
        semanticOutcome = {
          status: 'blocked',
          code: blocked.code,
          message: blocked.message,
        }
      }
      if (candidate.status === 'noop' && risk === 'safe') {
        diagnostics.push({
          code: 'TIMELINE_ALREADY_EXPORTABLE',
          severity: 'info',
          message: '时间线已符合安全导出约束，无需自动修复',
          elementIds: [],
        })
      }
      const planHash = sha256(JSON.stringify({
        version: 2,
        status: candidate.status,
        baseRevisionId: candidate.base.revision.id,
        sourceRevisionId: candidate.sourceRevisionId,
        atomicPlanHash: receipt?.planHash ?? null,
        semanticOutcome,
      }))
      return {
        sourceRevisionId: candidate.sourceRevisionId,
        schemaVersion: candidate.base.timelineDocument.schemaVersion,
        upstreamCommit: candidate.base.timelineDocument.upstreamCommit,
        strategy: receipt?.strategy ?? 'managed-dialogue-reflow-v1',
        executor: receipt?.executor ?? 'OpenCut-Classic/UpdateElementsCommand',
        planHash,
        risk,
        diagnostics,
        operations,
        changedElementIds: receipt?.changedElementIds ?? [],
        document: candidate.document,
      }
    },
  }
}

export interface TimelineAutoEditPlanRecord {
  id: string
  documentId: string
  projectId: string
  episodeId: string
  baseRevisionId: string
  sourceRevisionId: string | null
  goal: 'exportable'
  policy: 'safe'
  strategy: string
  executor: string
  upstreamCommit: string
  schemaVersion: number
  planHash: string
  integrityHash: string
  confirmationTokenHash: string
  risk: TimelineAutoEditRisk
  diagnostics: TimelineAutoEditDiagnostic[]
  operations: TimelineAutomaticEditReceipt['operations']
  changedElementIds: string[]
  previewDocument: JsonObject
  createdAt: string
}

export type PublicTimelineAutoEditPlan = Omit<
  TimelineAutoEditPlanRecord,
  'confirmationTokenHash' | 'integrityHash' | 'previewDocument'
>

export interface TimelineEditApplicationRecord {
  id: string
  planId: string
  documentId: string
  projectId: string
  episodeId: string
  baseRevisionId: string
  resultRevisionId: string
  idempotencyKeyHash: string
  requestHash: string
  createdAt: string
}

export interface TimelineEditUndoRecord {
  id: string
  applicationId: string
  documentId: string
  projectId: string
  episodeId: string
  baseRevisionId: string
  resultRevisionId: string
  idempotencyKeyHash: string
  requestHash: string
  createdAt: string
}

export interface TimelineAutoEditPreviewResult {
  timeline: TimelineDocumentSnapshot
  plan: PublicTimelineAutoEditPlan & { confirmationToken: string }
  previewDocument: JsonObject
  diagnostics: TimelineAutoEditDiagnostic[]
  operations: TimelineAutomaticEditReceipt['operations']
  risk: TimelineAutoEditRisk
  changedElementIds: string[]
}

export interface TimelineAutoEditApplyResult {
  /** Authoritative current document head. The HTTP ETag always identifies this snapshot. */
  timeline: TimelineDocumentSnapshot
  /** Immutable revision originally created by this application, even during a later replay. */
  operationResultTimeline: TimelineDocumentSnapshot
  /** True when the authoritative head has advanced beyond the immutable operation result. */
  headAdvanced: boolean
  application: PublicTimelineEditApplication
  plan: PublicTimelineAutoEditPlan
  diagnostics: TimelineAutoEditDiagnostic[]
  operations: TimelineAutomaticEditReceipt['operations']
  risk: TimelineAutoEditRisk
  changedElementIds: string[]
  idempotent: boolean
}

export interface TimelineAutoEditUndoResult {
  /** Authoritative current document head. The HTTP ETag always identifies this snapshot. */
  timeline: TimelineDocumentSnapshot
  /** Immutable revision originally created by this undo, even during a later replay. */
  operationResultTimeline: TimelineDocumentSnapshot
  /** True when the authoritative head has advanced beyond the immutable operation result. */
  headAdvanced: boolean
  application: PublicTimelineEditApplication
  undo: PublicTimelineEditUndo
  idempotent: boolean
}

export type PublicTimelineEditApplication = Omit<
  TimelineEditApplicationRecord,
  'idempotencyKeyHash' | 'requestHash'
>

export type PublicTimelineEditUndo = Omit<
  TimelineEditUndoRecord,
  'idempotencyKeyHash' | 'requestHash'
>

export type TimelineAutoEditErrorCode =
  | 'AUTO_EDIT_ALREADY_APPLIED'
  | 'AUTO_EDIT_ALREADY_UNDONE'
  | 'AUTO_EDIT_BLOCKED'
  | 'AUTO_EDIT_CONFIRMATION_INVALID'
  | 'AUTO_EDIT_IDEMPOTENCY_CONFLICT'
  | 'AUTO_EDIT_NO_CHANGES'
  | 'AUTO_EDIT_PLAN_CORRUPT'
  | 'AUTO_EDIT_PLAN_NOT_FOUND'
  | 'AUTO_EDIT_APPLICATION_NOT_FOUND'
  | 'AUTO_EDIT_REVISION_CONFLICT'
  | 'TIMELINE_MEDIA_RECONCILIATION_REQUIRED'

export class TimelineAutoEditError extends Error {
  constructor(
    readonly code: TimelineAutoEditErrorCode,
    message: string,
    readonly currentRevisionId?: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TimelineAutoEditError'
  }
}

interface CreatePlanInput extends TimelineAutoEditPlanRecord {}
interface CreateApplicationInput extends TimelineEditApplicationRecord {}
interface CreateUndoInput extends TimelineEditUndoRecord {}

type SqlRow = Record<string, unknown>

function requiredString(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not text`)
  return value
}

function nullableString(row: SqlRow, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not nullable text`)
  return value
}

function requiredNumber(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number') throw new Error(`Database column ${column} is not numeric`)
  return value
}

function parseJson(value: unknown, column: string): unknown {
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not JSON text`)
  return JSON.parse(value) as unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseObject(value: unknown, column: string): JsonObject {
  const parsed = parseJson(value, column)
  if (!isPlainObject(parsed)) throw new Error(`Database column ${column} is not a JSON object`)
  return parsed as JsonObject
}

function parseArray(value: unknown, column: string): JsonValue[] {
  const parsed = parseJson(value, column)
  if (!Array.isArray(parsed)) throw new Error(`Database column ${column} is not a JSON array`)
  return parsed as JsonValue[]
}

function parseDiagnostics(value: unknown): TimelineAutoEditDiagnostic[] {
  return parseArray(value, 'diagnostics_json').map((item) => {
    if (!isPlainObject(item)
      || typeof item.code !== 'string'
      || !['info', 'warning', 'error'].includes(String(item.severity))
      || typeof item.message !== 'string'
      || !Array.isArray(item.elementIds)
      || !item.elementIds.every((id) => typeof id === 'string')) {
      throw new Error('Database column diagnostics_json contains an invalid diagnostic')
    }
    return {
      code: item.code,
      severity: item.severity as TimelineAutoEditDiagnosticSeverity,
      message: item.message,
      elementIds: [...item.elementIds] as string[],
    }
  })
}

function parseOperations(value: unknown): TimelineAutomaticEditReceipt['operations'] {
  const items = parseArray(value, 'operations_json')
  if (!items.every(isPlainObject)) {
    throw new Error('Database column operations_json contains an invalid operation')
  }
  return items as unknown as TimelineAutomaticEditReceipt['operations']
}

function parseStringArray(value: unknown, column: string): string[] {
  const items = parseArray(value, column)
  if (!items.every((item) => typeof item === 'string')) {
    throw new Error(`Database column ${column} contains a non-string value`)
  }
  return items as string[]
}

function asPlan(row: SqlRow): TimelineAutoEditPlanRecord {
  const goal = requiredString(row, 'goal')
  const policy = requiredString(row, 'policy')
  const risk = requiredString(row, 'risk')
  if (goal !== 'exportable' || policy !== 'safe') throw new Error('Database contains invalid auto-edit policy')
  if (!['safe', 'confirmation-required', 'blocked'].includes(risk)) {
    throw new Error('Database contains invalid auto-edit risk')
  }
  return {
    id: requiredString(row, 'id'),
    documentId: requiredString(row, 'document_id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: requiredString(row, 'episode_id'),
    baseRevisionId: requiredString(row, 'base_revision_id'),
    sourceRevisionId: nullableString(row, 'source_revision_id'),
    goal,
    policy,
    strategy: requiredString(row, 'strategy'),
    executor: requiredString(row, 'executor'),
    upstreamCommit: requiredString(row, 'upstream_commit'),
    schemaVersion: requiredNumber(row, 'schema_version'),
    planHash: requiredString(row, 'plan_hash'),
    integrityHash: requiredString(row, 'integrity_hash'),
    confirmationTokenHash: requiredString(row, 'confirmation_token_hash'),
    risk: risk as TimelineAutoEditRisk,
    diagnostics: parseDiagnostics(row.diagnostics_json),
    operations: parseOperations(row.operations_json),
    changedElementIds: parseStringArray(row.changed_element_ids_json, 'changed_element_ids_json'),
    previewDocument: parseObject(row.preview_snapshot_json, 'preview_snapshot_json'),
    createdAt: requiredString(row, 'created_at'),
  }
}

function asApplication(row: SqlRow): TimelineEditApplicationRecord {
  return {
    id: requiredString(row, 'id'),
    planId: requiredString(row, 'plan_id'),
    documentId: requiredString(row, 'document_id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: requiredString(row, 'episode_id'),
    baseRevisionId: requiredString(row, 'base_revision_id'),
    resultRevisionId: requiredString(row, 'result_revision_id'),
    idempotencyKeyHash: requiredString(row, 'idempotency_key_hash'),
    requestHash: requiredString(row, 'request_hash'),
    createdAt: requiredString(row, 'created_at'),
  }
}

function asUndo(row: SqlRow): TimelineEditUndoRecord {
  return {
    id: requiredString(row, 'id'),
    applicationId: requiredString(row, 'application_id'),
    documentId: requiredString(row, 'document_id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: requiredString(row, 'episode_id'),
    baseRevisionId: requiredString(row, 'base_revision_id'),
    resultRevisionId: requiredString(row, 'result_revision_id'),
    idempotencyKeyHash: requiredString(row, 'idempotency_key_hash'),
    requestHash: requiredString(row, 'request_hash'),
    createdAt: requiredString(row, 'created_at'),
  }
}

export class SQLiteTimelineAutoEditRepository {
  constructor(private readonly database: ManjuDatabase) {}

  createPlan(input: CreatePlanInput): TimelineAutoEditPlanRecord {
    this.database.withSql((sql) => sql.run(`
      INSERT INTO timeline_auto_edit_plans (
        id, document_id, project_id, episode_id, base_revision_id,
        source_revision_id, goal, policy, strategy, executor, upstream_commit,
        schema_version, plan_hash, integrity_hash, confirmation_token_hash, risk,
        diagnostics_json, operations_json, changed_element_ids_json,
        preview_snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.id,
    input.documentId,
    input.projectId,
    input.episodeId,
    input.baseRevisionId,
    input.sourceRevisionId,
    input.goal,
    input.policy,
    input.strategy,
    input.executor,
    input.upstreamCommit,
    input.schemaVersion,
    input.planHash,
    input.integrityHash,
    input.confirmationTokenHash,
    input.risk,
    JSON.stringify(input.diagnostics),
    JSON.stringify(input.operations),
    JSON.stringify(input.changedElementIds),
    serializeTimelineDocument(input.previewDocument),
    input.createdAt))
    return this.requirePlan(input.id)
  }

  getPlan(id: string): TimelineAutoEditPlanRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(
      'SELECT * FROM timeline_auto_edit_plans WHERE id = ?',
      id,
    ))
    return row ? asPlan(row) : undefined
  }

  requirePlan(id: string): TimelineAutoEditPlanRecord {
    const plan = this.getPlan(id)
    if (!plan) throw new TimelineAutoEditError('AUTO_EDIT_PLAN_NOT_FOUND', '自动剪辑计划不存在')
    return plan
  }

  createApplication(input: CreateApplicationInput): TimelineEditApplicationRecord {
    this.database.withSql((sql) => sql.run(`
      INSERT INTO timeline_edit_applications (
        id, plan_id, document_id, project_id, episode_id, base_revision_id,
        result_revision_id, idempotency_key_hash, request_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.id,
    input.planId,
    input.documentId,
    input.projectId,
    input.episodeId,
    input.baseRevisionId,
    input.resultRevisionId,
    input.idempotencyKeyHash,
    input.requestHash,
    input.createdAt))
    return this.requireApplication(input.id)
  }

  getApplication(id: string): TimelineEditApplicationRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(
      'SELECT * FROM timeline_edit_applications WHERE id = ?',
      id,
    ))
    return row ? asApplication(row) : undefined
  }

  requireApplication(id: string): TimelineEditApplicationRecord {
    const application = this.getApplication(id)
    if (!application) {
      throw new TimelineAutoEditError('AUTO_EDIT_APPLICATION_NOT_FOUND', '自动剪辑应用记录不存在')
    }
    return application
  }

  findApplicationByPlan(planId: string): TimelineEditApplicationRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(
      'SELECT * FROM timeline_edit_applications WHERE plan_id = ?',
      planId,
    ))
    return row ? asApplication(row) : undefined
  }

  findApplicationByIdempotency(
    documentId: string,
    keyHash: string,
  ): TimelineEditApplicationRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(`
      SELECT * FROM timeline_edit_applications
       WHERE document_id = ? AND idempotency_key_hash = ?
    `, documentId, keyHash))
    return row ? asApplication(row) : undefined
  }

  createUndo(input: CreateUndoInput): TimelineEditUndoRecord {
    this.database.withSql((sql) => sql.run(`
      INSERT INTO timeline_edit_undos (
        id, application_id, document_id, project_id, episode_id,
        base_revision_id, result_revision_id, idempotency_key_hash,
        request_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.id,
    input.applicationId,
    input.documentId,
    input.projectId,
    input.episodeId,
    input.baseRevisionId,
    input.resultRevisionId,
    input.idempotencyKeyHash,
    input.requestHash,
    input.createdAt))
    return this.requireUndo(input.id)
  }

  getUndo(id: string): TimelineEditUndoRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(
      'SELECT * FROM timeline_edit_undos WHERE id = ?',
      id,
    ))
    return row ? asUndo(row) : undefined
  }

  requireUndo(id: string): TimelineEditUndoRecord {
    const undo = this.getUndo(id)
    if (!undo) throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '自动剪辑撤销记录损坏')
    return undo
  }

  findUndoByApplication(applicationId: string): TimelineEditUndoRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(
      'SELECT * FROM timeline_edit_undos WHERE application_id = ?',
      applicationId,
    ))
    return row ? asUndo(row) : undefined
  }

  findUndoByIdempotency(documentId: string, keyHash: string): TimelineEditUndoRecord | undefined {
    const row = this.database.withSql((sql) => sql.get(`
      SELECT * FROM timeline_edit_undos
       WHERE document_id = ? AND idempotency_key_hash = ?
    `, documentId, keyHash))
    return row ? asUndo(row) : undefined
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function integrityHash(input: Omit<TimelineAutoEditPlanRecord, 'id' | 'integrityHash' | 'createdAt'>): string {
  return sha256(JSON.stringify({
    version: 1,
    documentId: input.documentId,
    projectId: input.projectId,
    episodeId: input.episodeId,
    baseRevisionId: input.baseRevisionId,
    sourceRevisionId: input.sourceRevisionId,
    goal: input.goal,
    policy: input.policy,
    strategy: input.strategy,
    executor: input.executor,
    upstreamCommit: input.upstreamCommit,
    schemaVersion: input.schemaVersion,
    planHash: input.planHash,
    confirmationTokenHash: input.confirmationTokenHash,
    risk: input.risk,
    diagnostics: input.diagnostics,
    operations: input.operations,
    changedElementIds: input.changedElementIds,
    previewDocument: JSON.parse(serializeTimelineDocument(input.previewDocument)) as JsonObject,
  }))
}

function publicPlan(plan: TimelineAutoEditPlanRecord): PublicTimelineAutoEditPlan {
  const {
    confirmationTokenHash: _tokenHash,
    integrityHash: _integrityHash,
    previewDocument: _preview,
    ...result
  } = plan
  return result
}

function publicApplication(
  application: TimelineEditApplicationRecord,
): PublicTimelineEditApplication {
  const {
    idempotencyKeyHash: _idempotencyKeyHash,
    requestHash: _requestHash,
    ...result
  } = application
  return result
}

function publicUndo(undo: TimelineEditUndoRecord): PublicTimelineEditUndo {
  const {
    idempotencyKeyHash: _idempotencyKeyHash,
    requestHash: _requestHash,
    ...result
  } = undo
  return result
}

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(normalized)) {
    throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', `${label} 格式无效`)
  }
  return normalized
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 200) {
    throw new TimelineAutoEditError(
      'AUTO_EDIT_IDEMPOTENCY_CONFLICT',
      'Idempotency-Key 必须为 1–200 个字符',
    )
  }
  return normalized
}

function assertProposal(proposal: TimelineAutoEditProposal): void {
  serializeTimelineDocument(proposal.document)
  if (!Number.isSafeInteger(proposal.schemaVersion) || proposal.schemaVersion < 1) {
    throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '自动剪辑 schemaVersion 无效')
  }
  if (!/^[0-9a-f]{40}$/.test(proposal.upstreamCommit)) {
    throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '自动剪辑 upstreamCommit 无效')
  }
  if (!proposal.strategy.trim() || !proposal.executor.trim()) {
    throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '自动剪辑策略或执行器缺失')
  }
  if (!/^[0-9a-f]{64}$/.test(proposal.planHash)) {
    throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '自动剪辑 planHash 无效')
  }
  if (!['safe', 'confirmation-required', 'blocked'].includes(proposal.risk)) {
    throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '自动剪辑风险等级无效')
  }
  if (new Set(proposal.changedElementIds).size !== proposal.changedElementIds.length
    || proposal.changedElementIds.some((id) => !id.trim())) {
    throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '自动剪辑 changedElementIds 无效')
  }
  const operationIds = new Set(proposal.operations.map((operation) => operation.elementId))
  if (proposal.changedElementIds.some((id) => !operationIds.has(id))) {
    throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '变更片段与 OpenCut 操作不一致')
  }
  proposal.diagnostics.forEach((diagnostic) => {
    if (!diagnostic.code.trim()
      || !diagnostic.message.trim()
      || !['info', 'warning', 'error'].includes(diagnostic.severity)
      || diagnostic.elementIds.some((id) => !id.trim())) {
      throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '自动剪辑诊断无效')
    }
  })
  const hasBlockingDiagnostic = proposal.diagnostics.some((diagnostic) => (
    diagnostic.severity === 'error'
  ))
  if ((proposal.risk === 'blocked') !== hasBlockingDiagnostic
    || (proposal.risk === 'safe' && hasBlockingDiagnostic)) {
    throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '自动剪辑风险与阻断诊断不一致')
  }
}

function assertHead(current: TimelineDocumentSnapshot, expectedRevisionId: string): void {
  if (current.revision.id !== expectedRevisionId) {
    throw new TimelineAutoEditError(
      'AUTO_EDIT_REVISION_CONFLICT',
      '时间线已在其他编辑会话中更新，请刷新后重试',
      current.revision.id,
    )
  }
}

function confirmationMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Agentic auto-edit is a timing-only capability. A trusted media receipt may
 * flow through it only when the complete canonical document differs from the
 * immutable base in the four OpenCut timing fields and the two narrowly
 * audited provenance updates. This protects Story media, B-roll, audio,
 * subtitles, visibility, effects, tracks and unknown extensions alike.
 */
function mediaConsumptionProjection(document: JsonObject): string {
  let stable: Record<string, unknown>
  try {
    stable = structuredClone(
      canonicalizeOpenCutTimelineDocument(document).document,
    ) as unknown as Record<string, unknown>
  } catch (cause) {
    throw new TimelineAutoEditError(
      'AUTO_EDIT_PLAN_CORRUPT',
      '自动剪辑候选不符合 pinned OpenCut 时间线结构',
      undefined,
      { cause },
    )
  }
  const integration = stable.manjuTimeline
  if (isPlainObject(integration)) {
    const projectedIntegration = { ...integration }
    delete projectedIntegration.automaticEdit
    if (Object.keys(projectedIntegration).length > 0) {
      stable.manjuTimeline = projectedIntegration
    } else {
      delete stable.manjuTimeline
    }
  }
  const normalizeElement = (value: unknown): void => {
    if (!isPlainObject(value)) return
    delete value.startTime
    delete value.duration
    delete value.trimStart
    delete value.trimEnd
    if (isPlainObject(value.manju)) {
      const manju = { ...value.manju }
      if (isPlainObject(manju.shortVideoFill)) {
        const shortVideoFill = { ...manju.shortVideoFill }
        delete shortVideoFill.appliedByOpenCut
        delete shortVideoFill.appliedPlanHash
        manju.shortVideoFill = shortVideoFill
      }
      if (isPlainObject(manju.subtitleCue)) {
        const subtitleCue = { ...manju.subtitleCue }
        delete subtitleCue.sourceAudioStartTime
        delete subtitleCue.sourceAudioTrimStart
        delete subtitleCue.sourceAudioDuration
        manju.subtitleCue = subtitleCue
      }
      value.manju = manju
    }
  }
  const tracks = stable.tracks
  if (!isPlainObject(tracks)
    || !Array.isArray(tracks.overlay)
    || !isPlainObject(tracks.main)
    || !Array.isArray(tracks.audio)) {
    throw new TimelineAutoEditError(
      'AUTO_EDIT_PLAN_CORRUPT',
      '自动剪辑候选缺少 canonical OpenCut 轨道',
    )
  }
  for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
    if (!isPlainObject(track) || !Array.isArray(track.elements)) {
      throw new TimelineAutoEditError(
        'AUTO_EDIT_PLAN_CORRUPT',
        '自动剪辑候选包含无效轨道',
      )
    }
    track.elements.forEach(normalizeElement)
  }
  return JSON.stringify(stable)
}

function withApplicationReceipt(
  document: JsonObject,
  plan: TimelineAutoEditPlanRecord,
  applicationId: string,
): JsonObject {
  const result = structuredClone(document)
  const integration = isPlainObject(result.manjuTimeline) ? result.manjuTimeline : {}
  const receipt = isPlainObject(integration.automaticEdit) ? integration.automaticEdit : {}
  result.manjuTimeline = {
    ...integration,
      automaticEdit: {
      ...receipt,
      applicationId,
      planId: plan.id,
      planHash: plan.planHash,
      baseRevisionId: plan.baseRevisionId,
      strategy: plan.strategy,
      executor: plan.executor,
      risk: plan.risk,
      policy: 'auto-applied',
      operationCount: plan.operations.length,
      changedElementIds: plan.changedElementIds,
    } as unknown as JsonValue,
  }
  serializeTimelineDocument(result)
  return result
}

export interface TimelineAutoEditServiceOptions {
  now?: () => string
  idFactory?: () => string
  tokenFactory?: () => string
}

export class TimelineAutoEditService {
  private readonly now: () => string
  private readonly idFactory: () => string
  private readonly tokenFactory: () => string

  constructor(
    private readonly database: ManjuDatabase,
    private readonly timelines: TimelineDocumentService,
    private readonly repository: SQLiteTimelineAutoEditRepository,
    private readonly planner: TimelineAutoEditPlanner,
    options: TimelineAutoEditServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
    this.tokenFactory = options.tokenFactory
      ?? (() => `taec_${randomBytes(32).toString('base64url')}`)
  }

  preview(input: {
    projectId: string
    episodeId: string
    expectedRevisionId: string
    goal: 'exportable'
    policy: 'safe'
  }): TimelineAutoEditPreviewResult {
    return this.database.transaction(() => {
      const current = this.timelines.get(input.episodeId)
      assertHead(current, input.expectedRevisionId)
      if (current.timelineDocument.projectId !== input.projectId) {
        throw new TimelineDocumentError(
          'EPISODE_PROJECT_MISMATCH',
          `Episode ${input.episodeId} does not belong to project ${input.projectId}`,
        )
      }
      const proposal = this.planner.preview({
        projectId: input.projectId,
        episodeId: input.episodeId,
        goal: input.goal,
        policy: input.policy,
        base: current,
      })
      assertProposal(proposal)
      if (mediaConsumptionProjection(proposal.document)
        !== mediaConsumptionProjection(current.document)) {
        throw new TimelineAutoEditError(
          'AUTO_EDIT_PLAN_CORRUPT',
          '自动剪辑只能调整时间与受控补尾状态，不能替换镜头素材或改写媒体绑定',
          current.revision.id,
        )
      }
      const confirmationToken = this.tokenFactory()
      if (confirmationToken.length < 24 || confirmationToken.length > 500) {
        throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '确认能力生成失败')
      }
      const withoutHash = {
        documentId: current.timelineDocument.id,
        projectId: input.projectId,
        episodeId: input.episodeId,
        baseRevisionId: current.revision.id,
        sourceRevisionId: proposal.sourceRevisionId,
        goal: input.goal,
        policy: input.policy,
        strategy: proposal.strategy,
        executor: proposal.executor,
        upstreamCommit: proposal.upstreamCommit,
        schemaVersion: proposal.schemaVersion,
        confirmationTokenHash: sha256(confirmationToken),
        risk: proposal.risk,
        diagnostics: structuredClone(proposal.diagnostics),
        operations: structuredClone(proposal.operations),
        changedElementIds: [...proposal.changedElementIds],
        previewDocument: structuredClone(proposal.document),
        planHash: proposal.planHash,
      } satisfies Omit<TimelineAutoEditPlanRecord, 'id' | 'integrityHash' | 'createdAt'>
      const plan = this.repository.createPlan({
        id: this.idFactory(),
        ...withoutHash,
        integrityHash: integrityHash(withoutHash),
        createdAt: this.now(),
      })
      return {
        timeline: current,
        plan: { ...publicPlan(plan), confirmationToken },
        previewDocument: structuredClone(plan.previewDocument),
        diagnostics: structuredClone(plan.diagnostics),
        operations: structuredClone(plan.operations),
        risk: plan.risk,
        changedElementIds: [...plan.changedElementIds],
      }
    })
  }

  apply(input: {
    projectId: string
    episodeId: string
    expectedRevisionId: string
    idempotencyKey: string
    planId: string
    confirmationToken: string
  }): TimelineAutoEditApplyResult {
    const key = normalizeIdempotencyKey(input.idempotencyKey)
    const keyHash = sha256(key)
    const planId = assertIdentifier(input.planId, 'planId')
    return this.database.transaction(() => {
      const plan = this.repository.requirePlan(planId)
      this.assertPlanIntegrity(plan)
      if (plan.projectId !== input.projectId || plan.episodeId !== input.episodeId) {
        throw new TimelineAutoEditError('AUTO_EDIT_PLAN_NOT_FOUND', '自动剪辑计划不属于该分集')
      }
      const requestHash = sha256(JSON.stringify({ version: 1, action: 'apply', planId }))
      const replay = this.repository.findApplicationByIdempotency(plan.documentId, keyHash)
      if (replay) {
        if (replay.requestHash !== requestHash || replay.planId !== planId) {
          throw new TimelineAutoEditError(
            'AUTO_EDIT_IDEMPOTENCY_CONFLICT',
            '该 Idempotency-Key 已用于其他自动剪辑请求',
          )
        }
        return this.appliedResult(plan, replay, true)
      }
      if (this.repository.findApplicationByPlan(planId)) {
        throw new TimelineAutoEditError('AUTO_EDIT_ALREADY_APPLIED', '该自动剪辑计划已经应用')
      }
      const current = this.timelines.get(input.episodeId)
      assertHead(current, input.expectedRevisionId)
      if (current.revision.id !== plan.baseRevisionId) {
        throw new TimelineAutoEditError(
          'AUTO_EDIT_REVISION_CONFLICT',
          '预览后时间线已变更，请重新诊断',
          current.revision.id,
        )
      }
      const mediaAuthority = currentMediaAuthority(this.database, {
        projectId: plan.projectId,
        episodeId: plan.episodeId,
      })
      const baseAuthorityReceipt = timelineMediaAuthorityReceipt(
        this.database,
        current.revision.id,
      )
      const baseAuthorityMatches = current.revision.sourceRevisionId === mediaAuthority.sourceRevisionId
        && baseAuthorityReceipt?.documentId === current.timelineDocument.id
        && baseAuthorityReceipt?.projectId === plan.projectId
        && baseAuthorityReceipt?.episodeId === plan.episodeId
        && baseAuthorityReceipt?.sourceRevisionId === mediaAuthority.sourceRevisionId
        && baseAuthorityReceipt?.fingerprint === mediaAuthority.fingerprint
      if (mediaAuthority.receiptRequired && !baseAuthorityMatches) {
        throw new TimelineAutoEditError(
          'TIMELINE_MEDIA_RECONCILIATION_REQUIRED',
          '镜头选版已变化，请先对账当前媒体后再应用自动剪辑',
          current.revision.id,
        )
      }
      if (!confirmationMatches(input.confirmationToken, plan.confirmationTokenHash)) {
        throw new TimelineAutoEditError(
          'AUTO_EDIT_CONFIRMATION_INVALID',
          '自动剪辑确认凭证无效，请重新预览',
        )
      }
      if (plan.risk !== 'safe'
        || plan.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        throw new TimelineAutoEditError('AUTO_EDIT_BLOCKED', '该计划不符合安全自动应用策略')
      }
      if (plan.operations.length === 0 || plan.changedElementIds.length === 0) {
        throw new TimelineAutoEditError('AUTO_EDIT_NO_CHANGES', '时间线无需自动修复')
      }

      // Re-run the server-owned planner at apply time. Media metadata can
      // change without a timeline revision; comparing both the planner hash
      // and exact candidate prevents applying a preview the user never saw.
      const replanned = this.planner.preview({
        projectId: plan.projectId,
        episodeId: plan.episodeId,
        goal: plan.goal,
        policy: plan.policy,
        base: current,
      })
      assertProposal(replanned)
      if (mediaConsumptionProjection(replanned.document)
        !== mediaConsumptionProjection(current.document)) {
        throw new TimelineAutoEditError(
          'AUTO_EDIT_PLAN_CORRUPT',
          '自动剪辑重算结果改写了镜头素材或媒体绑定，已拒绝应用',
          current.revision.id,
        )
      }
      if (replanned.planHash !== plan.planHash
        || replanned.sourceRevisionId !== plan.sourceRevisionId
        || replanned.schemaVersion !== plan.schemaVersion
        || replanned.upstreamCommit !== plan.upstreamCommit
        || replanned.strategy !== plan.strategy
        || replanned.executor !== plan.executor
        || replanned.risk !== plan.risk
        || serializeTimelineDocument(replanned.document)
          !== serializeTimelineDocument(plan.previewDocument)) {
        throw new TimelineAutoEditError(
          'AUTO_EDIT_REVISION_CONFLICT',
          '自动剪辑诊断结果已变化，请重新预览后确认',
          current.revision.id,
        )
      }

      const applicationId = this.idFactory()
      const document = withApplicationReceipt(replanned.document, plan, applicationId)
      const saveInput = {
        projectId: plan.projectId,
        episodeId: plan.episodeId,
        expectedRevisionId: current.revision.id,
        schemaVersion: plan.schemaVersion,
        upstreamCommit: plan.upstreamCommit,
        summary: `Agentic 自动剪辑 · ${plan.strategy}`,
        document,
      }
      const saved = plan.sourceRevisionId
        ? this.timelines.saveReconciled({
            ...saveInput,
            sourceRevisionId: plan.sourceRevisionId,
            ...(baseAuthorityMatches
              ? { mediaAuthorityFingerprint: mediaAuthority.fingerprint }
              : {}),
          })
        : this.timelines.save(saveInput)
      const application = this.repository.createApplication({
        id: applicationId,
        planId: plan.id,
        documentId: plan.documentId,
        projectId: plan.projectId,
        episodeId: plan.episodeId,
        baseRevisionId: plan.baseRevisionId,
        resultRevisionId: saved.revision.id,
        idempotencyKeyHash: keyHash,
        requestHash,
        createdAt: this.now(),
      })
      return {
        timeline: saved,
        operationResultTimeline: saved,
        headAdvanced: false,
        application: publicApplication(application),
        plan: publicPlan(plan),
        diagnostics: structuredClone(plan.diagnostics),
        operations: structuredClone(plan.operations),
        risk: plan.risk,
        changedElementIds: [...plan.changedElementIds],
        idempotent: false,
      }
    })
  }

  undo(input: {
    applicationId: string
    expectedRevisionId: string
    idempotencyKey: string
  }): TimelineAutoEditUndoResult {
    const key = normalizeIdempotencyKey(input.idempotencyKey)
    const keyHash = sha256(key)
    const applicationId = assertIdentifier(input.applicationId, 'applicationId')
    return this.database.transaction(() => {
      const application = this.repository.requireApplication(applicationId)
      const requestHash = sha256(JSON.stringify({ version: 1, action: 'undo', applicationId }))
      const replay = this.repository.findUndoByIdempotency(application.documentId, keyHash)
      if (replay) {
        if (replay.requestHash !== requestHash || replay.applicationId !== applicationId) {
          throw new TimelineAutoEditError(
            'AUTO_EDIT_IDEMPOTENCY_CONFLICT',
            '该 Idempotency-Key 已用于其他撤销请求',
          )
        }
        const result = this.mutationTimelines(
          application.episodeId,
          application.documentId,
          replay.resultRevisionId,
        )
        return {
          ...result,
          application: publicApplication(application),
          undo: publicUndo(replay),
          idempotent: true,
        }
      }
      if (this.repository.findUndoByApplication(applicationId)) {
        throw new TimelineAutoEditError('AUTO_EDIT_ALREADY_UNDONE', '该自动剪辑已经撤销')
      }
      const current = this.timelines.get(application.episodeId)
      assertHead(current, input.expectedRevisionId)
      if (current.revision.id !== application.resultRevisionId) {
        throw new TimelineAutoEditError(
          'AUTO_EDIT_REVISION_CONFLICT',
          '自动剪辑后存在新的手工编辑，为避免覆盖已拒绝撤销',
          current.revision.id,
        )
      }
      const original = this.timelines.getRevision(application.baseRevisionId)
      if (original.timelineDocument.id !== application.documentId) {
        throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '撤销基线不属于该时间线')
      }
      const mediaAuthority = currentMediaAuthority(this.database, {
        projectId: application.projectId,
        episodeId: application.episodeId,
      })
      const currentAuthorityReceipt = timelineMediaAuthorityReceipt(
        this.database,
        current.revision.id,
      )
      const originalAuthorityReceipt = timelineMediaAuthorityReceipt(
        this.database,
        original.revision.id,
      )
      const mayStampAuthority = current.revision.sourceRevisionId === mediaAuthority.sourceRevisionId
        && original.revision.sourceRevisionId === mediaAuthority.sourceRevisionId
        && currentAuthorityReceipt?.documentId === application.documentId
        && originalAuthorityReceipt?.documentId === application.documentId
        && currentAuthorityReceipt?.projectId === application.projectId
        && originalAuthorityReceipt?.projectId === application.projectId
        && currentAuthorityReceipt?.episodeId === application.episodeId
        && originalAuthorityReceipt?.episodeId === application.episodeId
        && currentAuthorityReceipt?.sourceRevisionId === mediaAuthority.sourceRevisionId
        && originalAuthorityReceipt?.sourceRevisionId === mediaAuthority.sourceRevisionId
        && currentAuthorityReceipt?.fingerprint === mediaAuthority.fingerprint
        && originalAuthorityReceipt?.fingerprint === mediaAuthority.fingerprint
      const undoId = this.idFactory()
      const saveInput = {
        projectId: application.projectId,
        episodeId: application.episodeId,
        expectedRevisionId: current.revision.id,
        schemaVersion: original.revision.schemaVersion,
        upstreamCommit: original.revision.upstreamCommit,
        summary: `撤销 Agentic 自动剪辑 · ${application.id}`,
        document: structuredClone(original.document),
      }
      const saved = original.revision.sourceRevisionId
        ? this.timelines.saveReconciled({
            ...saveInput,
            sourceRevisionId: original.revision.sourceRevisionId,
            ...(mayStampAuthority
              ? { mediaAuthorityFingerprint: mediaAuthority.fingerprint }
              : {}),
          })
        : this.timelines.save(saveInput)
      const undo = this.repository.createUndo({
        id: undoId,
        applicationId: application.id,
        documentId: application.documentId,
        projectId: application.projectId,
        episodeId: application.episodeId,
        baseRevisionId: current.revision.id,
        resultRevisionId: saved.revision.id,
        idempotencyKeyHash: keyHash,
        requestHash,
        createdAt: this.now(),
      })
      return {
        timeline: saved,
        operationResultTimeline: saved,
        headAdvanced: false,
        application: publicApplication(application),
        undo: publicUndo(undo),
        idempotent: false,
      }
    })
  }

  private assertPlanIntegrity(plan: TimelineAutoEditPlanRecord): void {
    const { id: _id, integrityHash: storedHash, createdAt: _createdAt, ...withoutHash } = plan
    const actual = integrityHash(withoutHash)
    if (actual !== storedHash) {
      throw new TimelineAutoEditError('AUTO_EDIT_PLAN_CORRUPT', '自动剪辑计划完整性校验失败')
    }
  }

  private appliedResult(
    plan: TimelineAutoEditPlanRecord,
    application: TimelineEditApplicationRecord,
    idempotent: boolean,
  ): TimelineAutoEditApplyResult {
    const timelines = this.mutationTimelines(
      application.episodeId,
      application.documentId,
      application.resultRevisionId,
    )
    return {
      ...timelines,
      application: publicApplication(application),
      plan: publicPlan(plan),
      diagnostics: structuredClone(plan.diagnostics),
      operations: structuredClone(plan.operations),
      risk: plan.risk,
      changedElementIds: [...plan.changedElementIds],
      idempotent,
    }
  }

  /**
   * Keep the immutable operation result separate from the mutable document
   * head. An idempotent retry may arrive after another tab has created newer
   * revisions; replaying the old result as `timeline` would move the client's
   * persistence cursor backwards.
   */
  private mutationTimelines(
    episodeId: string,
    documentId: string,
    resultRevisionId: string,
  ): Pick<
    TimelineAutoEditApplyResult,
    'timeline' | 'operationResultTimeline' | 'headAdvanced'
  > {
    const timeline = this.timelines.get(episodeId)
    const operationResultTimeline = this.timelines.getRevision(resultRevisionId)
    if (timeline.timelineDocument.id !== documentId
      || operationResultTimeline.timelineDocument.id !== documentId) {
      throw new TimelineAutoEditError(
        'AUTO_EDIT_PLAN_CORRUPT',
        '自动剪辑幂等审计结果不属于当前时间线',
      )
    }
    return {
      timeline,
      operationResultTimeline,
      headAdvanced: timeline.revision.id !== operationResultTimeline.revision.id,
    }
  }
}
