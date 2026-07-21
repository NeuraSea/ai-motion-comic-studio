import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, posix, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'

import { withProviderPlatformCostPolicy } from './provider-cost-policy.js'
import type { JsonObject, JsonValue } from './types.js'

export const DATABASE_SCHEMA_VERSION = 19

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_provider'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type PipelineRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'

export type ProviderKind = 'text' | 'image' | 'video' | 'speech'
export type ProviderAuthMode = 'byoa' | 'byok' | 'none'

export interface ProjectRecord {
  id: string
  title: string
  currentEpisodeId: string | null
  currentRevisionId: string | null
  settings: JsonObject
  createdAt: string
  updatedAt: string
}

export interface CreateProjectInput {
  id?: string
  title: string
  currentEpisodeId?: string | null
  currentRevisionId?: string | null
  settings?: JsonObject
  createdAt?: string
  updatedAt?: string
}

export interface UpdateProjectInput {
  title?: string
  currentEpisodeId?: string | null
  currentRevisionId?: string | null
  settings?: JsonObject
}

export interface RevisionRecord {
  id: string
  projectId: string
  parentRevisionId: string | null
  summary: string
  snapshot: JsonObject
  createdAt: string
}

export interface CreateRevisionInput {
  id?: string
  projectId: string
  parentRevisionId?: string | null
  summary: string
  snapshot: JsonObject
  createdAt?: string
}

export interface UpdateRevisionInput {
  parentRevisionId?: string | null
  summary?: string
  snapshot?: JsonObject
}

export interface MediaAssetRecord {
  id: string
  projectId: string
  episodeId: string | null
  kind: string
  version: number
  status: string
  filePath: string | null
  mimeType: string | null
  width: number | null
  height: number | null
  durationSeconds: number | null
  checksum: string | null
  source: string
  providerId: string | null
  generationJobId: string | null
  generationParameters: JsonObject
  sourceRevisionId: string | null
  parentAssetId: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateMediaAssetInput {
  id?: string
  projectId: string
  episodeId?: string | null
  kind: string
  version?: number
  status?: string
  filePath?: string | null
  mimeType?: string | null
  width?: number | null
  height?: number | null
  durationSeconds?: number | null
  checksum?: string | null
  source: string
  providerId?: string | null
  generationJobId?: string | null
  generationParameters?: JsonObject
  sourceRevisionId?: string | null
  parentAssetId?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface UpdateMediaAssetInput {
  episodeId?: string | null
  kind?: string
  version?: number
  status?: string
  filePath?: string | null
  mimeType?: string | null
  width?: number | null
  height?: number | null
  durationSeconds?: number | null
  checksum?: string | null
  source?: string
  providerId?: string | null
  generationJobId?: string | null
  generationParameters?: JsonObject
  sourceRevisionId?: string | null
  parentAssetId?: string | null
}

export interface GenerationJobRecord {
  id: string
  projectId: string
  episodeId: string | null
  pipelineRunId: string | null
  type: string
  status: JobStatus
  progress: number
  resourceType: string | null
  resourceId: string | null
  providerId: string | null
  model: string | null
  providerConfigRevision: number | null
  externalTaskId: string | null
  idempotencyKey: string | null
  retryOf: string | null
  attempt: number
  input: JsonObject
  /** Provider polling cursor/status needed to resume asynchronous work after restart. */
  providerState: JsonObject
  /** Structured, user-safe detail for stage/ETA/messages beyond the numeric progress value. */
  progressDetail: JsonObject
  output: JsonObject | null
  error: JsonObject | null
  cost: JsonObject | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface PipelineRunRecord {
  id: string
  projectId: string
  episodeId: string | null
  idempotencyKey: string | null
  sourceRevisionId: string | null
  status: PipelineRunStatus
  progress: number
  steps: JsonObject
  error: JsonObject | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface CreatePipelineRunInput {
  id?: string
  projectId: string
  episodeId?: string | null
  idempotencyKey?: string | null
  sourceRevisionId?: string | null
  status?: PipelineRunStatus
  progress?: number
  steps?: JsonObject
  error?: JsonObject | null
  createdAt?: string
  updatedAt?: string
  completedAt?: string | null
}

export interface UpdatePipelineRunInput {
  status?: PipelineRunStatus
  progress?: number
  steps?: JsonObject
  error?: JsonObject | null
  completedAt?: string | null
}

export interface ListPipelineRunsOptions {
  projectId?: string
  episodeId?: string
  status?: PipelineRunStatus
  limit?: number
  offset?: number
}

export interface CreateGenerationJobInput {
  id?: string
  projectId: string
  episodeId?: string | null
  pipelineRunId?: string | null
  type: string
  status?: JobStatus
  progress?: number
  resourceType?: string | null
  resourceId?: string | null
  providerId?: string | null
  model?: string | null
  providerConfigRevision?: number | null
  externalTaskId?: string | null
  idempotencyKey?: string | null
  retryOf?: string | null
  attempt?: number
  input: JsonObject
  providerState?: JsonObject
  progressDetail?: JsonObject
  output?: JsonObject | null
  error?: JsonObject | null
  cost?: JsonObject | null
  createdAt?: string
  updatedAt?: string
  startedAt?: string | null
  completedAt?: string | null
}

export interface UpdateGenerationJobInput {
  status?: JobStatus
  progress?: number
  resourceType?: string | null
  resourceId?: string | null
  providerId?: string | null
  model?: string | null
  providerConfigRevision?: number | null
  externalTaskId?: string | null
  idempotencyKey?: string | null
  retryOf?: string | null
  attempt?: number
  input?: JsonObject
  providerState?: JsonObject
  progressDetail?: JsonObject
  output?: JsonObject | null
  error?: JsonObject | null
  cost?: JsonObject | null
  startedAt?: string | null
  completedAt?: string | null
}

export interface ListGenerationJobsOptions {
  projectId?: string
  episodeId?: string
  pipelineRunId?: string
  status?: JobStatus
  type?: string
  limit?: number
  offset?: number
}

export interface KeychainReference {
  service: string
  account: string
}

export interface ProviderConnectionRecord {
  id: string
  kind: ProviderKind
  adapter: string
  displayName: string
  baseUrl: string | null
  defaultModel: string | null
  authMode: ProviderAuthMode
  credentialReference: KeychainReference | null
  config: JsonObject
  configRevision: number
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** Immutable, secret-free execution profile captured for durable jobs. */
export interface ProviderConnectionVersionRecord {
  providerId: string
  configRevision: number
  kind: ProviderKind
  adapter: string
  baseUrl: string | null
  model: string | null
  authMode: ProviderAuthMode
  credentialReference: KeychainReference | null
  executionConfig: JsonObject
  createdAt: string
}

export interface CreateProviderConnectionInput {
  id?: string
  kind: ProviderKind
  adapter: string
  displayName: string
  baseUrl?: string | null
  defaultModel?: string | null
  authMode: ProviderAuthMode
  credentialReference?: KeychainReference | null
  config?: JsonObject
  enabled?: boolean
  createdAt?: string
  updatedAt?: string
}

export interface UpdateProviderConnectionInput {
  kind?: ProviderKind
  adapter?: string
  displayName?: string
  baseUrl?: string | null
  defaultModel?: string | null
  authMode?: ProviderAuthMode
  credentialReference?: KeychainReference | null
  config?: JsonObject
  enabled?: boolean
}

export interface LegacyImportCounts {
  projects: number
  episodes: number
  revisions: number
  scenes: number
  shots: number
  dialogueLines: number
  jobs: number
  assets: number
}

export type LegacyImportResult =
  | { status: 'not-found'; sourcePath: string }
  | { status: 'already-imported'; sourcePath: string; projectId: string }
  | {
    status: 'imported'
    sourcePath: string
    projectId: string
    checksum: string
    counts: LegacyImportCounts
  }

export interface LegacyImportRecord {
  sourcePath: string
  sourceChecksum: string
  sourceVersion: number
  projectId: string
  counts: LegacyImportCounts
  importedAt: string
}

export interface DatabaseHealth {
  schemaVersion: number
  foreignKeys: boolean
  journalMode: string
  quickCheck: string
}

export interface DatabaseOptions {
  runtimeDirectory?: string
  databasePath?: string
  /** `false` disables automatic import. Defaults to `<runtime>/state.json`. */
  legacyStatePath?: string | false
  busyTimeoutMs?: number
  /** Root for verified pre-migration SQLite + media-index snapshots. `false` disables only in tests. */
  backupDirectory?: string | false
  now?: () => string
  idFactory?: () => string
}

export class DatabaseIntegrityError extends Error {
  readonly code = 'CROSS_PROJECT_REFERENCE'

  constructor(
    readonly projectId: string,
    readonly referenceType: string,
    readonly referenceId: string,
  ) {
    super(`${referenceType} ${referenceId} belongs to another project`)
    this.name = 'DatabaseIntegrityError'
  }
}

export class ProviderVersionIntegrityError extends Error {
  readonly code = 'INVALID_PROVIDER_VERSION'

  constructor(message: string) {
    super(message)
    this.name = 'ProviderVersionIntegrityError'
  }
}

type SqlRow = Record<string, unknown>

/**
 * Deliberately small SQL surface for infrastructure repositories that need to
 * persist normalized domain graphs. It does not expose connection lifecycle,
 * pragmas, extensions, or transaction control; callers must use
 * {@link ManjuDatabase.transaction} for multi-statement writes.
 */
export interface DatabaseSqlAccess {
  get(sql: string, ...bindings: SQLInputValue[]): Record<string, unknown> | undefined
  all(sql: string, ...bindings: SQLInputValue[]): Array<Record<string, unknown>>
  run(sql: string, ...bindings: SQLInputValue[]): { changes: number }
}

const JOB_STATUSES = new Set<JobStatus>([
  'queued',
  'running',
  'waiting_provider',
  'succeeded',
  'failed',
  'cancelled',
])

const PIPELINE_RUN_STATUSES = new Set<PipelineRunStatus>([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'stale',
])

const SENSITIVE_JSON_KEYS = new Set([
  'apikey',
  'authorization',
  'bearer',
  'bearertoken',
  'clientsecret',
  'credential',
  'credentials',
  'idtoken',
  'oauthtoken',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'secret',
  'sessiontoken',
  'token',
  'accesstoken',
])

const PROVIDER_RUNTIME_CONFIG_KEYS = new Set([
  'isDefault',
  'lastTestedAt',
  'lastTestStatus',
  'lastTestMessage',
])

const SCHEMA_SQL = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  current_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  current_revision_id TEXT REFERENCES revisions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  target_duration_seconds REAL,
  aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  style_preset TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, sort_order)
) STRICT;

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_revision_id TEXT REFERENCES revisions(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  story_description TEXT NOT NULL DEFAULT '',
  visual_description TEXT NOT NULL DEFAULT '',
  locked_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  story_description TEXT NOT NULL DEFAULT '',
  visual_description TEXT NOT NULL DEFAULT '',
  locked_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE props (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  story_description TEXT NOT NULL DEFAULT '',
  visual_description TEXT NOT NULL DEFAULT '',
  locked_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (episode_id, sequence)
) STRICT;

CREATE TABLE shots (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  code TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  framing TEXT NOT NULL DEFAULT '',
  movement TEXT NOT NULL DEFAULT '',
  transition TEXT NOT NULL DEFAULT '',
  duration_seconds REAL NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  timeline_start_seconds REAL CHECK (timeline_start_seconds IS NULL OR timeline_start_seconds >= 0),
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  storyboard_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  video_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  source_revision_id TEXT REFERENCES revisions(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scene_id, sequence)
) STRICT;

CREATE TABLE dialogue_lines (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  kind TEXT NOT NULL DEFAULT 'dialogue' CHECK (kind IN ('dialogue', 'narration')),
  text TEXT NOT NULL,
  voice_id TEXT,
  speech_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  start_seconds REAL CHECK (start_seconds IS NULL OR start_seconds >= 0),
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shot_id, sequence)
) STRICT;

CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  steps_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(steps_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'video', 'speech')),
  adapter TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT,
  default_model TEXT,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('byoa', 'byok', 'none')),
  keychain_service TEXT,
  keychain_account TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision >= 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((keychain_service IS NULL) = (keychain_account IS NULL))
) STRICT;

CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  pipeline_run_id TEXT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_provider', 'succeeded', 'failed', 'cancelled')),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  resource_type TEXT,
  resource_id TEXT,
  provider_id TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
  model TEXT,
  provider_config_revision INTEGER CHECK (provider_config_revision IS NULL OR provider_config_revision >= 1),
  external_task_id TEXT,
  idempotency_key TEXT,
  retry_of TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  provider_state_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provider_state_json)),
  progress_detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_detail_json)),
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  cost_json TEXT CHECK (cost_json IS NULL OR json_valid(cost_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
) STRICT;

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  status TEXT NOT NULL DEFAULT 'ready',
  file_path TEXT,
  mime_type TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  checksum TEXT,
  source TEXT NOT NULL,
  provider_id TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
  generation_job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
  generation_parameters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(generation_parameters_json)),
  source_revision_id TEXT REFERENCES revisions(id) ON DELETE SET NULL,
  parent_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  timeline_snapshot_json TEXT NOT NULL CHECK (json_valid(timeline_snapshot_json)),
  output_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  specification_json TEXT NOT NULL CHECK (json_valid(specification_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE quality_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  export_id TEXT REFERENCES exports(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  passed INTEGER NOT NULL DEFAULT 0 CHECK (passed IN (0, 1)),
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE legacy_imports (
  source_path TEXT PRIMARY KEY,
  source_checksum TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  -- Deliberately not a foreign key: the import tombstone must survive project deletion,
  -- otherwise a still-present legacy state.json would silently recreate that project.
  project_id TEXT NOT NULL,
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
  imported_at TEXT NOT NULL
) STRICT;

CREATE INDEX episodes_project_idx ON episodes(project_id, sort_order);
CREATE INDEX revisions_project_idx ON revisions(project_id, created_at DESC);
CREATE INDEX characters_project_idx ON characters(project_id);
CREATE INDEX locations_project_idx ON locations(project_id);
CREATE INDEX props_project_idx ON props(project_id);
CREATE INDEX scenes_episode_idx ON scenes(episode_id, sequence);
CREATE INDEX shots_scene_idx ON shots(scene_id, sequence);
CREATE INDEX dialogue_lines_shot_idx ON dialogue_lines(shot_id, sequence);
CREATE INDEX media_assets_project_idx ON media_assets(project_id, kind, created_at DESC);
CREATE INDEX media_assets_job_idx ON media_assets(generation_job_id);
CREATE INDEX generation_jobs_project_idx ON generation_jobs(project_id, created_at DESC);
CREATE INDEX generation_jobs_status_idx ON generation_jobs(status, created_at);
CREATE INDEX generation_jobs_external_idx ON generation_jobs(provider_id, external_task_id);
CREATE UNIQUE INDEX generation_jobs_idempotency_idx
  ON generation_jobs(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX pipeline_runs_project_idx ON pipeline_runs(project_id, created_at DESC);
CREATE INDEX exports_episode_idx ON exports(episode_id, created_at DESC);
CREATE INDEX quality_reports_export_idx ON quality_reports(export_id);
`

const PROVIDER_VERSION_SCHEMA_SQL = `
CREATE TABLE provider_connection_versions (
  provider_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK (config_revision >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'video', 'speech')),
  adapter TEXT NOT NULL,
  base_url TEXT,
  model TEXT,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('byoa', 'byok', 'none')),
  keychain_service TEXT,
  keychain_account TEXT,
  execution_config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(execution_config_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, config_revision),
  CHECK ((keychain_service IS NULL) = (keychain_account IS NULL))
) STRICT;
CREATE INDEX provider_connection_versions_created_idx
  ON provider_connection_versions(provider_id, created_at);
CREATE TRIGGER provider_connection_versions_no_update
BEFORE UPDATE ON provider_connection_versions
BEGIN
  SELECT RAISE(ABORT, 'provider connection versions are immutable');
END;
CREATE TRIGGER provider_connection_versions_no_delete
BEFORE DELETE ON provider_connection_versions
BEGIN
  SELECT RAISE(ABORT, 'provider connection versions are immutable');
END;
`

const TIMELINE_DOCUMENT_SCHEMA_SQL = `
-- Composite parent keys let SQLite enforce that timeline documents cannot be
-- attached to an episode (or source revision) owned by another project.
CREATE UNIQUE INDEX episodes_id_project_unique ON episodes(id, project_id);
CREATE UNIQUE INDEX revisions_id_project_unique ON revisions(id, project_id);

CREATE TABLE timeline_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  upstream_commit TEXT NOT NULL CHECK (
    length(upstream_commit) = 40
    AND upstream_commit NOT GLOB '*[^0-9a-f]*'
  ),
  source_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (episode_id),
  UNIQUE (id, project_id, episode_id),
  FOREIGN KEY (episode_id, project_id)
    REFERENCES episodes(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (source_revision_id, project_id)
    REFERENCES revisions(id, project_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (current_revision_id, id)
    REFERENCES timeline_document_revisions(id, document_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE timeline_document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  parent_revision_id TEXT,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  upstream_commit TEXT NOT NULL CHECK (
    length(upstream_commit) = 40
    AND upstream_commit NOT GLOB '*[^0-9a-f]*'
  ),
  source_revision_id TEXT,
  summary TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE (id, document_id),
  FOREIGN KEY (document_id, project_id, episode_id)
    REFERENCES timeline_documents(id, project_id, episode_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_revision_id, document_id)
    REFERENCES timeline_document_revisions(id, document_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (source_revision_id, project_id)
    REFERENCES revisions(id, project_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX timeline_documents_project_idx
  ON timeline_documents(project_id, updated_at DESC);
CREATE INDEX timeline_document_revisions_document_idx
  ON timeline_document_revisions(document_id, created_at DESC, id DESC);

-- Snapshots are append-only. Deleting the owning project/episode remains
-- possible through the document's cascading lifecycle, but an existing
-- revision can never be rewritten in place.
CREATE TRIGGER timeline_document_revisions_no_update
BEFORE UPDATE ON timeline_document_revisions
BEGIN
  SELECT RAISE(ABORT, 'timeline document revisions are immutable');
END;

-- A future export worker can pin the exact revision consumed by both browser
-- preview and FFmpeg instead of reading a mutable document head.
ALTER TABLE exports
  ADD COLUMN timeline_document_revision_id TEXT
    REFERENCES timeline_document_revisions(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX exports_timeline_document_revision_idx
  ON exports(timeline_document_revision_id);
`

const QUALITY_REPORT_BINDING_SCHEMA_SQL = `
-- quality_reports.checks_json starts with a server-created binding and is
-- enriched by the worker with measured checks. The producer/export/asset
-- identity is immutable even while the rest of the report is completed.
CREATE TRIGGER quality_reports_binding_no_update
BEFORE UPDATE ON quality_reports
WHEN
  OLD.project_id IS NOT NEW.project_id
  OR OLD.episode_id IS NOT NEW.episode_id
  OR OLD.export_id IS NOT NEW.export_id
  OR json_extract(OLD.checks_json, '$.binding.version')
       IS NOT json_extract(NEW.checks_json, '$.binding.version')
  OR json_extract(OLD.checks_json, '$.binding.exportId')
       IS NOT json_extract(NEW.checks_json, '$.binding.exportId')
  OR json_extract(OLD.checks_json, '$.binding.outputAssetId')
       IS NOT json_extract(NEW.checks_json, '$.binding.outputAssetId')
  OR json_extract(OLD.checks_json, '$.binding.outputAssetChecksum')
       IS NOT json_extract(NEW.checks_json, '$.binding.outputAssetChecksum')
  OR json_extract(OLD.checks_json, '$.binding.timelineRevisionId')
       IS NOT json_extract(NEW.checks_json, '$.binding.timelineRevisionId')
  OR json_extract(OLD.checks_json, '$.binding.storyRevisionId')
       IS NOT json_extract(NEW.checks_json, '$.binding.storyRevisionId')
  OR json_extract(OLD.checks_json, '$.binding.exportSpecification')
       IS NOT json_extract(NEW.checks_json, '$.binding.exportSpecification')
  OR json_extract(OLD.checks_json, '$.binding.expected')
       IS NOT json_extract(NEW.checks_json, '$.binding.expected')
  OR json_extract(OLD.checks_json, '$.policy')
       IS NOT json_extract(NEW.checks_json, '$.policy')
BEGIN
  SELECT RAISE(ABORT, 'quality report binding is immutable');
END;
`

const PIPELINE_RUN_SCHEMA_SQL = `
ALTER TABLE pipeline_runs
  ADD COLUMN idempotency_key TEXT;
ALTER TABLE pipeline_runs
  ADD COLUMN source_revision_id TEXT
    REFERENCES revisions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX pipeline_runs_idempotency_idx
  ON pipeline_runs(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX generation_jobs_pipeline_idx
  ON generation_jobs(pipeline_run_id, created_at DESC, id DESC);
`

const TIMELINE_AUTO_EDIT_SCHEMA_SQL = `
-- A preview is a server-authored, immutable capability. The client never
-- supplies OpenCut operations or a replacement document. Only a hash of the
-- one-time confirmation token is durable so database snapshots cannot be used
-- to apply an edit without the user's explicit confirmation.
CREATE TABLE timeline_auto_edit_plans (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  source_revision_id TEXT,
  goal TEXT NOT NULL CHECK (goal = 'exportable'),
  policy TEXT NOT NULL CHECK (policy = 'safe'),
  strategy TEXT NOT NULL,
  executor TEXT NOT NULL,
  upstream_commit TEXT NOT NULL CHECK (
    length(upstream_commit) = 40
    AND upstream_commit NOT GLOB '*[^0-9a-f]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  plan_hash TEXT NOT NULL CHECK (
    length(plan_hash) = 64
    AND plan_hash NOT GLOB '*[^0-9a-f]*'
  ),
  integrity_hash TEXT NOT NULL CHECK (
    length(integrity_hash) = 64
    AND integrity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  confirmation_token_hash TEXT NOT NULL CHECK (
    length(confirmation_token_hash) = 64
    AND confirmation_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  risk TEXT NOT NULL CHECK (risk IN ('safe', 'confirmation-required', 'blocked')),
  diagnostics_json TEXT NOT NULL CHECK (
    json_valid(diagnostics_json) AND json_type(diagnostics_json) = 'array'
  ),
  operations_json TEXT NOT NULL CHECK (
    json_valid(operations_json) AND json_type(operations_json) = 'array'
  ),
  changed_element_ids_json TEXT NOT NULL CHECK (
    json_valid(changed_element_ids_json) AND json_type(changed_element_ids_json) = 'array'
  ),
  preview_snapshot_json TEXT NOT NULL CHECK (
    json_valid(preview_snapshot_json) AND json_type(preview_snapshot_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (id, document_id),
  FOREIGN KEY (document_id, project_id, episode_id)
    REFERENCES timeline_documents(id, project_id, episode_id) ON DELETE CASCADE,
  FOREIGN KEY (base_revision_id, document_id)
    REFERENCES timeline_document_revisions(id, document_id),
  FOREIGN KEY (source_revision_id, project_id)
    REFERENCES revisions(id, project_id)
) STRICT;

CREATE INDEX timeline_auto_edit_plans_document_idx
  ON timeline_auto_edit_plans(document_id, created_at DESC, id DESC);

CREATE TRIGGER timeline_auto_edit_plans_no_update
BEFORE UPDATE ON timeline_auto_edit_plans
BEGIN
  SELECT RAISE(ABORT, 'timeline auto edit plans are immutable');
END;

CREATE TABLE timeline_edit_applications (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  result_revision_id TEXT NOT NULL UNIQUE,
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (id, document_id),
  UNIQUE (document_id, idempotency_key_hash),
  FOREIGN KEY (plan_id, document_id)
    REFERENCES timeline_auto_edit_plans(id, document_id),
  FOREIGN KEY (document_id, project_id, episode_id)
    REFERENCES timeline_documents(id, project_id, episode_id) ON DELETE CASCADE,
  FOREIGN KEY (base_revision_id, document_id)
    REFERENCES timeline_document_revisions(id, document_id),
  FOREIGN KEY (result_revision_id, document_id)
    REFERENCES timeline_document_revisions(id, document_id)
) STRICT;

CREATE INDEX timeline_edit_applications_document_idx
  ON timeline_edit_applications(document_id, created_at DESC, id DESC);

CREATE TRIGGER timeline_edit_applications_no_update
BEFORE UPDATE ON timeline_edit_applications
BEGIN
  SELECT RAISE(ABORT, 'timeline edit applications are immutable');
END;

CREATE TABLE timeline_edit_undos (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  result_revision_id TEXT NOT NULL UNIQUE,
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (document_id, idempotency_key_hash),
  FOREIGN KEY (application_id, document_id)
    REFERENCES timeline_edit_applications(id, document_id),
  FOREIGN KEY (document_id, project_id, episode_id)
    REFERENCES timeline_documents(id, project_id, episode_id) ON DELETE CASCADE,
  FOREIGN KEY (base_revision_id, document_id)
    REFERENCES timeline_document_revisions(id, document_id),
  FOREIGN KEY (result_revision_id, document_id)
    REFERENCES timeline_document_revisions(id, document_id)
) STRICT;

CREATE INDEX timeline_edit_undos_document_idx
  ON timeline_edit_undos(document_id, created_at DESC, id DESC);

CREATE TRIGGER timeline_edit_undos_no_update
BEFORE UPDATE ON timeline_edit_undos
BEGIN
  SELECT RAISE(ABORT, 'timeline edit undos are immutable');
END;
`

const TIMELINE_AUTO_EDIT_DELETE_GUARD_SCHEMA_SQL = `
-- The three automatic-edit tables are an append-only audit chain. UPDATE was
-- already prohibited in v7; v8 closes the remaining direct-DELETE path while
-- preserving every historical capability, application, and undo receipt.
CREATE TRIGGER timeline_auto_edit_plans_no_delete
BEFORE DELETE ON timeline_auto_edit_plans
BEGIN
  SELECT RAISE(ABORT, 'timeline auto edit plans are immutable');
END;

CREATE TRIGGER timeline_edit_applications_no_delete
BEFORE DELETE ON timeline_edit_applications
BEGIN
  SELECT RAISE(ABORT, 'timeline edit applications are immutable');
END;

CREATE TRIGGER timeline_edit_undos_no_delete
BEFORE DELETE ON timeline_edit_undos
BEGIN
  SELECT RAISE(ABORT, 'timeline edit undos are immutable');
END;
`

const STORY_AND_CHARACTER_REFERENCE_SCOPE_SCHEMA_SQL = `
-- Story revisions share the project-wide revisions table with provider,
-- voice, and asset audit snapshots.  This explicit scope prevents a Story
-- revision from one episode being restored into another episode merely
-- because both belong to the same project.
CREATE TABLE story_revision_scopes (
  revision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (revision_id, project_id)
    REFERENCES revisions(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (episode_id, project_id)
    REFERENCES episodes(id, project_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX story_revision_scopes_episode_idx
  ON story_revision_scopes(episode_id, created_at DESC, revision_id DESC);

CREATE TRIGGER story_revision_scopes_no_update
BEFORE UPDATE ON story_revision_scopes
BEGIN
  SELECT RAISE(ABORT, 'story revision scopes are immutable');
END;

-- A character keeps its existing primary turnaround in
-- characters.locked_asset_id. These three explicit slots hold independently
-- addressable view Assets; the audit revision records every atomic set change.
CREATE TABLE character_visual_references (
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('front', 'side', 'back')),
  asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  audit_revision_id TEXT NOT NULL REFERENCES revisions(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (character_id, role)
) STRICT;

CREATE INDEX character_visual_references_asset_idx
  ON character_visual_references(asset_id)
  WHERE asset_id IS NOT NULL;

CREATE TRIGGER character_visual_references_validate_insert
BEFORE INSERT ON character_visual_references
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM characters
    WHERE characters.id = NEW.character_id
      AND characters.project_id = NEW.project_id
      AND characters.episode_id = NEW.episode_id
  ) THEN RAISE(ABORT, 'character visual reference owner mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM revisions
    WHERE revisions.id = NEW.audit_revision_id
      AND revisions.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'character visual reference revision mismatch') END;
  SELECT CASE WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM media_assets
    WHERE media_assets.id = NEW.asset_id
      AND media_assets.project_id = NEW.project_id
      AND media_assets.episode_id = NEW.episode_id
  ) THEN RAISE(ABORT, 'character visual reference asset mismatch') END;
END;

CREATE TRIGGER character_visual_references_validate_update
BEFORE UPDATE ON character_visual_references
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM characters
    WHERE characters.id = NEW.character_id
      AND characters.project_id = NEW.project_id
      AND characters.episode_id = NEW.episode_id
  ) THEN RAISE(ABORT, 'character visual reference owner mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM revisions
    WHERE revisions.id = NEW.audit_revision_id
      AND revisions.project_id = NEW.project_id
  ) THEN RAISE(ABORT, 'character visual reference revision mismatch') END;
  SELECT CASE WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM media_assets
    WHERE media_assets.id = NEW.asset_id
      AND media_assets.project_id = NEW.project_id
      AND media_assets.episode_id = NEW.episode_id
  ) THEN RAISE(ABORT, 'character visual reference asset mismatch') END;
END;

-- Migration cannot prove which episode owns an arbitrary historical revision.
-- Backfill only a valid Story-shaped revision that is the current head of
-- exactly one episode. Historical rows and shared heads remain unscoped and
-- therefore fail closed until a new, explicit Story save establishes scope.
INSERT INTO story_revision_scopes (
  revision_id, project_id, episode_id, created_at
)
SELECT
  revisions.id,
  revisions.project_id,
  min(episodes.id),
  revisions.created_at
FROM revisions
JOIN episodes
  ON episodes.project_id = revisions.project_id
 AND episodes.source_revision_id = revisions.id
WHERE json_type(revisions.snapshot_json) = 'object'
  AND json_extract(revisions.snapshot_json, '$.version') = 1
  AND json_type(revisions.snapshot_json, '$.bible') = 'object'
  AND json_type(revisions.snapshot_json, '$.characters') = 'array'
  AND json_type(revisions.snapshot_json, '$.locations') = 'array'
  AND json_type(revisions.snapshot_json, '$.props') = 'array'
  AND json_type(revisions.snapshot_json, '$.scenes') = 'array'
GROUP BY revisions.id, revisions.project_id, revisions.created_at
HAVING count(*) = 1;
`

const STORY_SCOPED_REVISION_IMMUTABILITY_SCHEMA_SQL = `
-- v10 closes the direct revision mutation paths left open by v9. IF NOT
-- EXISTS makes the step safe for fresh/pre-v9 databases that pass through
-- both schema installations in one migration transaction.
-- Project deletion remains legal: once the owning project row is gone, its
-- foreign-key cascade may remove the otherwise immutable Story snapshot.
CREATE TRIGGER IF NOT EXISTS story_scoped_revisions_no_update
BEFORE UPDATE ON revisions
WHEN EXISTS (
  SELECT 1 FROM story_revision_scopes
  WHERE story_revision_scopes.revision_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'scoped story revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS story_scoped_revisions_no_delete
BEFORE DELETE ON revisions
WHEN EXISTS (
  SELECT 1 FROM story_revision_scopes
  WHERE story_revision_scopes.revision_id = OLD.id
)
AND EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = OLD.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'scoped story revisions are immutable');
END;
`

const RELEASE_REVIEW_SCHEMA_SQL = `
-- Manual release review is a durable, append-only approval decision over one
-- exact technical-QC result and one exact exported asset.  The service still
-- revalidates every mutable head before release; these columns preserve what
-- the reviewer actually saw even after later Story/timeline/export changes.
CREATE TABLE IF NOT EXISTS release_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  export_id TEXT NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  output_asset_id TEXT NOT NULL REFERENCES media_assets(id),
  output_asset_checksum TEXT NOT NULL CHECK (
    length(output_asset_checksum) = 64
    AND output_asset_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_document_revisions(id),
  story_revision_id TEXT NOT NULL REFERENCES revisions(id),
  quality_report_id TEXT NOT NULL REFERENCES quality_reports(id),
  quality_policy_version INTEGER NOT NULL CHECK (quality_policy_version >= 1),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  checklist_json TEXT NOT NULL CHECK (
    json_valid(checklist_json)
    AND json_type(checklist_json) = 'object'
    AND json_type(checklist_json, '$.audioVideoSync') IN ('true', 'false')
    AND json_type(checklist_json, '$.subtitleSyncAndComplete') IN ('true', 'false')
    AND json_type(checklist_json, '$.characterVisualSemantics') IN ('true', 'false')
  ),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reviewed_at TEXT NOT NULL,
  UNIQUE (export_id, idempotency_key_hash)
) STRICT;

CREATE INDEX IF NOT EXISTS release_reviews_export_idx
  ON release_reviews(export_id, reviewed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS release_reviews_quality_report_idx
  ON release_reviews(quality_report_id);

CREATE TRIGGER IF NOT EXISTS release_reviews_no_update
BEFORE UPDATE ON release_reviews
BEGIN
  SELECT RAISE(ABORT, 'release reviews are immutable');
END;

-- Project deletion remains the explicit lifecycle boundary. Direct deletion
-- of an approval while its project still exists would erase audit evidence.
CREATE TRIGGER IF NOT EXISTS release_reviews_no_delete
BEFORE DELETE ON release_reviews
WHEN EXISTS (
  SELECT 1 FROM projects WHERE projects.id = OLD.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'release reviews are immutable');
END;
`

const TIMELINE_REVISION_RESTORE_SCHEMA_SQL = `
-- A restore never rewinds timeline_documents.current_revision_id. It copies
-- one immutable historical snapshot into a new child revision and records the
-- exact request/result binding for crash-safe idempotent replay.
CREATE TABLE IF NOT EXISTS timeline_revision_restores (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  target_revision_id TEXT NOT NULL,
  result_revision_id TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  stale_exports INTEGER NOT NULL DEFAULT 0 CHECK (stale_exports >= 0),
  stale_quality_reports INTEGER NOT NULL DEFAULT 0 CHECK (stale_quality_reports >= 0),
  stale_pipeline_runs INTEGER NOT NULL DEFAULT 0 CHECK (stale_pipeline_runs >= 0),
  stale_generation_jobs INTEGER NOT NULL DEFAULT 0 CHECK (stale_generation_jobs >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key_hash),
  UNIQUE (result_revision_id),
  FOREIGN KEY (document_id, project_id, episode_id)
    REFERENCES timeline_documents(id, project_id, episode_id) ON DELETE CASCADE,
  FOREIGN KEY (base_revision_id, document_id)
    REFERENCES timeline_document_revisions(id, document_id),
  FOREIGN KEY (target_revision_id, document_id)
    REFERENCES timeline_document_revisions(id, document_id),
  FOREIGN KEY (result_revision_id, document_id)
    REFERENCES timeline_document_revisions(id, document_id)
) STRICT;

CREATE INDEX IF NOT EXISTS timeline_revision_restores_document_idx
  ON timeline_revision_restores(document_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS timeline_revision_restores_no_update
BEFORE UPDATE ON timeline_revision_restores
BEGIN
  SELECT RAISE(ABORT, 'timeline revision restores are immutable');
END;

CREATE TRIGGER IF NOT EXISTS timeline_revision_restores_no_delete
BEFORE DELETE ON timeline_revision_restores
WHEN EXISTS (
  SELECT 1 FROM projects WHERE projects.id = OLD.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'timeline revision restores are immutable');
END;
`

const SHOT_MEDIA_REVIEW_SCHEMA_SQL = `
-- One row is one immutable human decision over one exact current-Story Shot
-- candidate. The mutable selected fact deliberately remains on shots; this
-- table preserves who/what was selected without turning an audit log into a
-- second source of truth.
CREATE TABLE IF NOT EXISTS shot_media_review_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL,
  shot_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('storyboard', 'video')),
  decision TEXT NOT NULL CHECK (decision IN ('adopt', 'reject', 'restore')),
  asset_id TEXT NOT NULL REFERENCES media_assets(id),
  previous_asset_id TEXT REFERENCES media_assets(id),
  selected_asset_id TEXT REFERENCES media_assets(id),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  expected_episode_version TEXT NOT NULL CHECK (
    length(expected_episode_version) BETWEEN 1 AND 1000
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  timeline_reconcile_required INTEGER NOT NULL DEFAULT 0 CHECK (
    timeline_reconcile_required IN (0, 1)
  ),
  -- A storyboard replacement may make the currently selected video unsafe.
  -- Keep the immutable video Asset, but record the exact pointer cleared by
  -- the same transaction so replay/audit can explain why it disappeared.
  cleared_video_asset_id TEXT REFERENCES media_assets(id),
  stale_generation_jobs INTEGER NOT NULL DEFAULT 0 CHECK (stale_generation_jobs >= 0),
  stale_shot_video_jobs INTEGER NOT NULL DEFAULT 0 CHECK (
    stale_shot_video_jobs >= 0
    AND stale_shot_video_jobs <= stale_generation_jobs
  ),
  stale_exports INTEGER NOT NULL DEFAULT 0 CHECK (stale_exports >= 0),
  stale_quality_reports INTEGER NOT NULL DEFAULT 0 CHECK (stale_quality_reports >= 0),
  stale_pipeline_runs INTEGER NOT NULL DEFAULT 0 CHECK (stale_pipeline_runs >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key_hash),
  CHECK (
    (decision IN ('adopt', 'restore') AND selected_asset_id = asset_id)
    OR (decision = 'reject' AND selected_asset_id IS previous_asset_id)
  ),
  CHECK (
    cleared_video_asset_id IS NULL
    OR (media_type = 'storyboard' AND timeline_reconcile_required = 1)
  ),
  FOREIGN KEY (episode_id, project_id)
    REFERENCES episodes(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (source_revision_id, project_id)
    REFERENCES revisions(id, project_id)
) STRICT;

CREATE INDEX IF NOT EXISTS shot_media_review_scope_idx
  ON shot_media_review_decisions(
    project_id, episode_id, shot_id, source_revision_id, media_type,
    created_at DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS shot_media_review_asset_idx
  ON shot_media_review_decisions(asset_id, created_at DESC, id DESC);

-- Protect the basic relational and provider-binding invariants even from an
-- infrastructure caller that bypasses the HTTP service. Public Story IDs and
-- the complete JSON shape are revalidated by the service before this insert.
CREATE TRIGGER IF NOT EXISTS shot_media_review_validate_insert
BEFORE INSERT ON shot_media_review_decisions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM shots
      JOIN scenes ON scenes.id = shots.scene_id
      JOIN episodes ON episodes.id = scenes.episode_id
     WHERE shots.id = NEW.shot_id
       AND episodes.id = NEW.episode_id
       AND episodes.project_id = NEW.project_id
       AND episodes.source_revision_id = NEW.source_revision_id
       AND shots.source_revision_id = NEW.source_revision_id
  ) THEN RAISE(ABORT, 'shot media review scope mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM media_assets
      JOIN generation_jobs ON generation_jobs.id = media_assets.generation_job_id
     WHERE media_assets.id = NEW.asset_id
       AND media_assets.project_id = NEW.project_id
       AND media_assets.episode_id = NEW.episode_id
       AND media_assets.source_revision_id = NEW.source_revision_id
       AND media_assets.status = 'ready'
       AND generation_jobs.project_id = NEW.project_id
       AND generation_jobs.episode_id = NEW.episode_id
       AND generation_jobs.status = 'succeeded'
       AND (
         (
           NEW.media_type = 'storyboard'
           AND media_assets.kind = 'storyboard'
           AND media_assets.mime_type IN ('image/gif', 'image/jpeg', 'image/png', 'image/webp')
           AND generation_jobs.type = 'asset.image.generate'
           AND json_extract(generation_jobs.input_json, '$.storyboardBinding.databaseShotId') = NEW.shot_id
           AND json_extract(generation_jobs.input_json, '$.storyboardBinding.expectedRevisionId') = NEW.source_revision_id
         )
         OR (
           NEW.media_type = 'video'
           AND media_assets.kind = 'shot.video'
           AND media_assets.mime_type IN ('video/mp4', 'video/webm')
           AND generation_jobs.type = 'shot.video.generate'
           AND json_extract(generation_jobs.input_json, '$.binding.databaseShotId') = NEW.shot_id
           AND json_extract(generation_jobs.input_json, '$.binding.expectedRevisionId') = NEW.source_revision_id
         )
       )
  ) THEN RAISE(ABORT, 'shot media review asset mismatch') END;

  SELECT CASE WHEN NEW.previous_asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM media_assets
     WHERE media_assets.id = NEW.previous_asset_id
       AND media_assets.project_id = NEW.project_id
       AND media_assets.episode_id = NEW.episode_id
       AND media_assets.source_revision_id = NEW.source_revision_id
       AND (
         (
           NEW.media_type = 'storyboard'
           AND media_assets.kind = 'storyboard'
           AND media_assets.mime_type IN ('image/gif', 'image/jpeg', 'image/png', 'image/webp')
         )
         OR (
           NEW.media_type = 'video'
           AND media_assets.kind = 'shot.video'
           AND media_assets.mime_type IN ('video/mp4', 'video/webm')
         )
       )
  ) THEN RAISE(ABORT, 'shot media review previous asset mismatch') END;

  SELECT CASE WHEN NEW.selected_asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM media_assets
     WHERE media_assets.id = NEW.selected_asset_id
       AND media_assets.project_id = NEW.project_id
       AND media_assets.episode_id = NEW.episode_id
       AND media_assets.source_revision_id = NEW.source_revision_id
       AND (
         (
           NEW.media_type = 'storyboard'
           AND media_assets.kind = 'storyboard'
           AND media_assets.mime_type IN ('image/gif', 'image/jpeg', 'image/png', 'image/webp')
         )
         OR (
           NEW.media_type = 'video'
           AND media_assets.kind = 'shot.video'
           AND media_assets.mime_type IN ('video/mp4', 'video/webm')
         )
       )
  ) THEN RAISE(ABORT, 'shot media review selected asset mismatch') END;

  SELECT CASE WHEN NEW.cleared_video_asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM media_assets
     WHERE media_assets.id = NEW.cleared_video_asset_id
       AND media_assets.project_id = NEW.project_id
       AND media_assets.episode_id = NEW.episode_id
       AND media_assets.source_revision_id = NEW.source_revision_id
       AND media_assets.kind = 'shot.video'
  ) THEN RAISE(ABORT, 'shot media review cleared video mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS shot_media_review_no_update
BEFORE UPDATE ON shot_media_review_decisions
BEGIN
  SELECT RAISE(ABORT, 'shot media review decisions are immutable');
END;

-- Project/Episode deletion remains the lifecycle boundary. A direct delete
-- while both owners still exist would erase review evidence and is refused.
CREATE TRIGGER IF NOT EXISTS shot_media_review_no_delete
BEFORE DELETE ON shot_media_review_decisions
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND EXISTS (SELECT 1 FROM episodes WHERE id = OLD.episode_id)
BEGIN
  SELECT RAISE(ABORT, 'shot media review decisions are immutable');
END;
`

const TIMELINE_MEDIA_AUTHORITY_RECEIPT_SCHEMA_SQL = `
-- The JSON field in a timeline snapshot is informational only. Trust is
-- established by this server-written, revision-bound receipt so a client
-- cannot precompute and inject a future media-authority hash.
CREATE TABLE IF NOT EXISTS timeline_media_authority_receipts (
  timeline_revision_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64
    AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (timeline_revision_id, document_id)
    REFERENCES timeline_document_revisions(id, document_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, project_id, episode_id)
    REFERENCES timeline_documents(id, project_id, episode_id) ON DELETE CASCADE,
  FOREIGN KEY (source_revision_id, project_id)
    REFERENCES revisions(id, project_id)
) STRICT;

CREATE INDEX IF NOT EXISTS timeline_media_authority_receipts_scope_idx
  ON timeline_media_authority_receipts(
    project_id, episode_id, source_revision_id, timeline_revision_id
  );

CREATE TRIGGER IF NOT EXISTS timeline_media_authority_receipts_validate_insert
BEFORE INSERT ON timeline_media_authority_receipts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM timeline_document_revisions
     WHERE timeline_document_revisions.id = NEW.timeline_revision_id
       AND timeline_document_revisions.document_id = NEW.document_id
       AND timeline_document_revisions.project_id = NEW.project_id
       AND timeline_document_revisions.episode_id = NEW.episode_id
       AND timeline_document_revisions.source_revision_id = NEW.source_revision_id
  ) THEN RAISE(ABORT, 'timeline media authority receipt scope mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS timeline_media_authority_receipts_no_update
BEFORE UPDATE ON timeline_media_authority_receipts
BEGIN
  SELECT RAISE(ABORT, 'timeline media authority receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS timeline_media_authority_receipts_no_delete
BEFORE DELETE ON timeline_media_authority_receipts
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND EXISTS (
   SELECT 1 FROM episodes
    WHERE id = OLD.episode_id AND project_id = OLD.project_id
 )
 AND EXISTS (
   SELECT 1 FROM timeline_document_revisions
    WHERE id = OLD.timeline_revision_id
 )
BEGIN
  SELECT RAISE(ABORT, 'timeline media authority receipts are immutable');
END;
`

const ASSET_IDENTITY_SCHEMA_SQL = `
-- A MediaAsset row remains one immutable file/version. asset_handles adds the
-- stable, project-level identity users switch between without changing any
-- existing media_assets.id semantics. A nullable current pointer keeps the
-- stable handle addressable even if retention later removes every version.
CREATE TABLE IF NOT EXISTS asset_handles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  current_asset_version_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, project_id)
) STRICT;

CREATE TABLE IF NOT EXISTS asset_handle_versions (
  asset_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  asset_version_id TEXT PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  checksum TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, version_number),
  FOREIGN KEY (asset_id, project_id)
    REFERENCES asset_handles(id, project_id) ON DELETE CASCADE
) STRICT;

-- One row is the immutable audit receipt for one switch intent. IDs and the
-- checksum are snapshots rather than foreign keys so retention cannot erase
-- the explanation of a past choice.
CREATE TABLE IF NOT EXISTS asset_version_switches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  previous_asset_version_id TEXT,
  selected_asset_version_id TEXT NOT NULL,
  selected_asset_version_checksum TEXT,
  handle_revision INTEGER NOT NULL CHECK (handle_revision >= 1),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (asset_id, project_id)
    REFERENCES asset_handles(id, project_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS asset_handles_project_idx
  ON asset_handles(project_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS asset_handle_versions_asset_idx
  ON asset_handle_versions(asset_id, version_number DESC);
CREATE INDEX IF NOT EXISTS asset_version_switches_asset_idx
  ON asset_version_switches(project_id, asset_id, created_at DESC, id DESC);

-- Backfill is intentionally conservative. Only an explicit assetFamilyId is
-- allowed to join old rows into one family. parent_asset_id is also used by
-- derived three-view crops and therefore must never be treated as a generic
-- version edge.
CREATE TEMP TABLE asset_identity_backfill (
  asset_version_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  checksum TEXT,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO asset_identity_backfill (
  asset_version_id, asset_id, project_id, kind, checksum, created_at
)
WITH RECURSIVE family_chain (
  asset_version_id, project_id, kind, candidate_id, next_id,
  checksum, created_at, depth, path
) AS (
  SELECT
    asset.id,
    asset.project_id,
    asset.kind,
    asset.id,
    CASE WHEN json_type(asset.generation_parameters_json, '$.assetFamilyId') = 'text'
      AND EXISTS (
        SELECT 1 FROM media_assets AS family
        WHERE family.id = json_extract(asset.generation_parameters_json, '$.assetFamilyId')
          AND family.project_id = asset.project_id
          AND family.kind = asset.kind
      )
      THEN json_extract(asset.generation_parameters_json, '$.assetFamilyId')
      ELSE NULL
    END,
    asset.checksum,
    asset.created_at,
    0,
    '|' || asset.id || '|'
  FROM media_assets AS asset

  UNION ALL

  SELECT
    chain.asset_version_id,
    chain.project_id,
    chain.kind,
    family.id,
    CASE WHEN json_type(family.generation_parameters_json, '$.assetFamilyId') = 'text'
      AND EXISTS (
        SELECT 1 FROM media_assets AS parent_family
        WHERE parent_family.id = json_extract(family.generation_parameters_json, '$.assetFamilyId')
          AND parent_family.project_id = chain.project_id
          AND parent_family.kind = chain.kind
      )
      THEN json_extract(family.generation_parameters_json, '$.assetFamilyId')
      ELSE NULL
    END,
    chain.checksum,
    chain.created_at,
    chain.depth + 1,
    chain.path || family.id || '|'
  FROM family_chain AS chain
  JOIN media_assets AS family
    ON family.id = chain.next_id
   AND family.project_id = chain.project_id
   AND family.kind = chain.kind
  WHERE chain.depth < 100
    AND instr(chain.path, '|' || family.id || '|') = 0
)
SELECT
  asset.id,
  COALESCE(
    (
      -- Only a chain that terminates at a real same-kind root is adopted.
      -- Cycles/depth overflow have no terminal row and safely fall back to
      -- the version's own ID instead of merging unrelated materials.
      SELECT chain.candidate_id
      FROM family_chain AS chain
      WHERE chain.asset_version_id = asset.id
        AND chain.next_id IS NULL
      ORDER BY chain.depth DESC
      LIMIT 1
    ),
    asset.id
  ),
  asset.project_id,
  asset.kind,
  asset.checksum,
  asset.created_at
FROM media_assets AS asset;

INSERT OR IGNORE INTO asset_handles (
  id, project_id, kind, current_asset_version_id, revision, created_at, updated_at
)
SELECT
  mapping.asset_id,
  mapping.project_id,
  mapping.kind,
  (
    SELECT candidate.asset_version_id
    FROM asset_identity_backfill AS candidate
    JOIN media_assets AS version ON version.id = candidate.asset_version_id
    WHERE candidate.asset_id = mapping.asset_id
      AND candidate.project_id = mapping.project_id
      AND version.status = 'ready'
      AND length(version.checksum) = 64
      AND version.checksum NOT GLOB '*[^0-9a-f]*'
    ORDER BY
      version.version DESC,
      version.created_at DESC,
      version.id DESC
    LIMIT 1
  ),
  1,
  min(mapping.created_at),
  max(mapping.created_at)
FROM asset_identity_backfill AS mapping
GROUP BY mapping.asset_id, mapping.project_id, mapping.kind;

INSERT OR IGNORE INTO asset_handle_versions (
  asset_id, project_id, asset_version_id, version_number, checksum, created_at
)
SELECT
  ranked.asset_id,
  ranked.project_id,
  ranked.asset_version_id,
  ranked.version_number,
  ranked.checksum,
  ranked.created_at
FROM (
  SELECT
    mapping.*,
    row_number() OVER (
      PARTITION BY mapping.asset_id, mapping.project_id
      ORDER BY version.version ASC, version.created_at ASC, version.id ASC
    ) AS version_number
  FROM asset_identity_backfill AS mapping
  JOIN media_assets AS version ON version.id = mapping.asset_version_id
) AS ranked;

DROP TABLE asset_identity_backfill;

-- Every future MediaAsset receives a stable handle. Reuse happens only when
-- the producer explicitly writes assetFamilyId and that family exists in the
-- same project with the same material kind; otherwise the new version starts
-- its own family. This makes uploads/exports/derived assets safe by default.
CREATE TRIGGER IF NOT EXISTS media_assets_register_asset_identity
AFTER INSERT ON media_assets
BEGIN
  INSERT OR IGNORE INTO asset_handles (
    id, project_id, kind, current_asset_version_id, revision, created_at, updated_at
  ) VALUES (
    COALESCE(
      (
        SELECT handle.id
        FROM asset_handles AS handle
        LEFT JOIN asset_handle_versions AS member
          ON member.asset_id = handle.id
         AND member.project_id = handle.project_id
        WHERE handle.project_id = NEW.project_id
          AND handle.kind = NEW.kind
          AND json_type(NEW.generation_parameters_json, '$.assetFamilyId') = 'text'
          AND (
            handle.id = json_extract(NEW.generation_parameters_json, '$.assetFamilyId')
            OR member.asset_version_id = json_extract(NEW.generation_parameters_json, '$.assetFamilyId')
          )
        ORDER BY CASE
          WHEN handle.id = json_extract(NEW.generation_parameters_json, '$.assetFamilyId') THEN 0
          ELSE 1
        END
        LIMIT 1
      ),
      NEW.id
    ),
    NEW.project_id,
    NEW.kind,
    CASE WHEN NEW.status = 'ready'
      AND length(NEW.checksum) = 64
      AND NEW.checksum NOT GLOB '*[^0-9a-f]*'
      THEN NEW.id ELSE NULL END,
    1,
    NEW.created_at,
    NEW.created_at
  );

  INSERT INTO asset_handle_versions (
    asset_id, project_id, asset_version_id, version_number, checksum, created_at
  )
  SELECT
    handle.id,
    NEW.project_id,
    NEW.id,
    COALESCE((
      SELECT max(existing.version_number) + 1
      FROM asset_handle_versions AS existing
      WHERE existing.asset_id = handle.id
        AND existing.project_id = NEW.project_id
    ), 1),
    NEW.checksum,
    NEW.created_at
  FROM asset_handles AS handle
  WHERE handle.project_id = NEW.project_id
    AND handle.kind = NEW.kind
    AND handle.id = COALESCE(
      (
        SELECT family.id
        FROM asset_handles AS family
        LEFT JOIN asset_handle_versions AS member
          ON member.asset_id = family.id
         AND member.project_id = family.project_id
        WHERE family.project_id = NEW.project_id
          AND family.kind = NEW.kind
          AND json_type(NEW.generation_parameters_json, '$.assetFamilyId') = 'text'
          AND (
            family.id = json_extract(NEW.generation_parameters_json, '$.assetFamilyId')
            OR member.asset_version_id = json_extract(NEW.generation_parameters_json, '$.assetFamilyId')
          )
        ORDER BY CASE
          WHEN family.id = json_extract(NEW.generation_parameters_json, '$.assetFamilyId') THEN 0
          ELSE 1
        END
        LIMIT 1
      ),
      NEW.id
    );

  UPDATE asset_handles
  SET current_asset_version_id = NEW.id,
      revision = CASE WHEN current_asset_version_id IS NEW.id THEN revision ELSE revision + 1 END,
      updated_at = NEW.created_at
  WHERE project_id = NEW.project_id
    AND kind = NEW.kind
    AND NEW.status = 'ready'
    AND length(NEW.checksum) = 64
    AND NEW.checksum NOT GLOB '*[^0-9a-f]*'
    AND id = (
      SELECT asset_id FROM asset_handle_versions WHERE asset_version_id = NEW.id
    );
END;

-- If retention removes the selected file, keep the stable handle and move its
-- pointer to the latest surviving immutable version. This is a retention
-- lifecycle fallback, not a user-driven switch, and does not call a Provider.
CREATE TRIGGER IF NOT EXISTS media_assets_repair_asset_identity_before_delete
BEFORE DELETE ON media_assets
WHEN EXISTS (
  SELECT 1 FROM asset_handles WHERE current_asset_version_id = OLD.id
)
BEGIN
  UPDATE asset_handles
  SET current_asset_version_id = (
        SELECT member.asset_version_id
        FROM asset_handle_versions AS member
        JOIN media_assets AS version ON version.id = member.asset_version_id
        WHERE member.asset_id = asset_handles.id
          AND member.asset_version_id <> OLD.id
          AND version.status = 'ready'
          AND length(member.checksum) = 64
          AND member.checksum NOT GLOB '*[^0-9a-f]*'
          AND member.checksum = version.checksum
        ORDER BY member.version_number DESC
        LIMIT 1
      ),
      revision = revision + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE current_asset_version_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS asset_handle_versions_no_update
BEFORE UPDATE ON asset_handle_versions
WHEN NOT (
  OLD.checksum IS NULL
  AND NEW.checksum IS NOT NULL
  AND OLD.asset_id IS NEW.asset_id
  AND OLD.project_id IS NEW.project_id
  AND OLD.asset_version_id IS NEW.asset_version_id
  AND OLD.version_number IS NEW.version_number
  AND OLD.created_at IS NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'asset versions are immutable');
END;

-- Normal MediaStore writes arrive already checksummed. This one-way seal is a
-- compatibility path for a future staged insert (or a legacy recovery) that
-- starts with NULL and later publishes its first checksum. Once non-NULL the
-- snapshot can never be rewritten.
CREATE TRIGGER IF NOT EXISTS media_assets_seal_asset_identity_checksum
AFTER UPDATE OF checksum ON media_assets
WHEN OLD.checksum IS NULL AND NEW.checksum IS NOT NULL
BEGIN
  UPDATE asset_handle_versions
  SET checksum = NEW.checksum
  WHERE asset_version_id = NEW.id AND checksum IS NULL;
END;

-- A staged version never displaces a usable default. Its first transition to
-- ready + sealed checksum publishes it atomically as the family default.
CREATE TRIGGER IF NOT EXISTS media_assets_publish_asset_identity_current
AFTER UPDATE OF status, checksum ON media_assets
WHEN NEW.status = 'ready'
 AND length(NEW.checksum) = 64
 AND NEW.checksum NOT GLOB '*[^0-9a-f]*'
 AND NOT (
   OLD.status = 'ready'
   AND length(OLD.checksum) = 64
   AND OLD.checksum NOT GLOB '*[^0-9a-f]*'
 )
BEGIN
  UPDATE asset_handles
  SET current_asset_version_id = NEW.id,
      revision = CASE WHEN current_asset_version_id IS NEW.id THEN revision ELSE revision + 1 END,
      updated_at = NEW.updated_at
  WHERE project_id = NEW.project_id
    AND id = (
      SELECT asset_id FROM asset_handle_versions WHERE asset_version_id = NEW.id
    );
END;

CREATE TRIGGER IF NOT EXISTS asset_version_switches_no_update
BEFORE UPDATE ON asset_version_switches
BEGIN
  SELECT RAISE(ABORT, 'asset version switches are immutable');
END;

CREATE TRIGGER IF NOT EXISTS asset_version_switches_no_delete
BEFORE DELETE ON asset_version_switches
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'asset version switches are immutable');
END;
`

const PRODUCTION_ASSET_MANIFEST_SCHEMA_SQL = `
-- A Production Asset Manifest is the immutable, Episode-scoped bill of
-- materials consumed by production. Stable asset_id and exact
-- asset_version_id are both copied into the receipt so a later Catalog
-- default switch cannot make an existing production drift.
CREATE TABLE IF NOT EXISTS production_asset_manifests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  parent_manifest_id TEXT REFERENCES production_asset_manifests(id),
  source_revision_id TEXT NOT NULL,
  project_revision_id TEXT,
  timeline_revision_id TEXT,
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64
    AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  entry_count INTEGER NOT NULL CHECK (entry_count >= 1),
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 500),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, episode_id, revision_number),
  UNIQUE (project_id, episode_id, idempotency_key),
  UNIQUE (id, project_id, episode_id),
  FOREIGN KEY (episode_id, project_id)
    REFERENCES episodes(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (source_revision_id, project_id)
    REFERENCES revisions(id, project_id),
  FOREIGN KEY (project_revision_id, project_id)
    REFERENCES revisions(id, project_id)
) STRICT;

CREATE TABLE IF NOT EXISTS production_asset_manifest_entries (
  manifest_id TEXT NOT NULL REFERENCES production_asset_manifests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  slot_key TEXT NOT NULL CHECK (length(trim(slot_key)) BETWEEN 1 AND 500),
  role TEXT NOT NULL CHECK (length(trim(role)) BETWEEN 1 AND 100),
  asset_id TEXT NOT NULL CHECK (length(trim(asset_id)) BETWEEN 1 AND 200),
  asset_version_id TEXT NOT NULL CHECK (length(trim(asset_version_id)) BETWEEN 1 AND 200),
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  checksum TEXT NOT NULL CHECK (
    length(checksum) = 64
    AND checksum NOT GLOB '*[^0-9a-f]*'
  ),
  kind TEXT NOT NULL,
  mime_type TEXT,
  source_revision_id TEXT,
  provider_id TEXT,
  provider_model TEXT,
  provider_config_revision INTEGER CHECK (
    provider_config_revision IS NULL OR provider_config_revision >= 1
  ),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  PRIMARY KEY (manifest_id, position),
  UNIQUE (manifest_id, slot_key)
) STRICT;

CREATE INDEX IF NOT EXISTS production_asset_manifests_episode_idx
  ON production_asset_manifests(project_id, episode_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS production_asset_manifest_entries_version_idx
  ON production_asset_manifest_entries(asset_version_id, manifest_id);
CREATE INDEX IF NOT EXISTS production_asset_manifest_entries_handle_idx
  ON production_asset_manifest_entries(asset_id, manifest_id);

CREATE TRIGGER IF NOT EXISTS production_asset_manifests_no_update
BEFORE UPDATE ON production_asset_manifests
BEGIN
  SELECT RAISE(ABORT, 'production asset manifests are immutable');
END;

CREATE TRIGGER IF NOT EXISTS production_asset_manifest_entries_no_update
BEFORE UPDATE ON production_asset_manifest_entries
BEGIN
  SELECT RAISE(ABORT, 'production asset manifest entries are immutable');
END;

CREATE TRIGGER IF NOT EXISTS production_asset_manifests_no_delete
BEFORE DELETE ON production_asset_manifests
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
 AND EXISTS (
   SELECT 1 FROM episodes
    WHERE id = OLD.episode_id AND project_id = OLD.project_id
 )
BEGIN
  SELECT RAISE(ABORT, 'production asset manifests are immutable');
END;

CREATE TRIGGER IF NOT EXISTS production_asset_manifest_entries_no_delete
BEFORE DELETE ON production_asset_manifest_entries
WHEN EXISTS (
  SELECT 1
    FROM production_asset_manifests AS manifest
    JOIN projects ON projects.id = manifest.project_id
    JOIN episodes
      ON episodes.id = manifest.episode_id
     AND episodes.project_id = manifest.project_id
   WHERE manifest.id = OLD.manifest_id
)
BEGIN
  SELECT RAISE(ABORT, 'production asset manifest entries are immutable');
END;

CREATE TRIGGER IF NOT EXISTS production_asset_manifests_validate_parent
BEFORE INSERT ON production_asset_manifests
WHEN NEW.parent_manifest_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM production_asset_manifests AS parent
    WHERE parent.id = NEW.parent_manifest_id
      AND parent.project_id = NEW.project_id
      AND parent.episode_id = NEW.episode_id
      AND parent.revision_number = NEW.revision_number - 1
  ) THEN RAISE(ABORT, 'production asset manifest parent mismatch') END;
END;
`

const PROJECT_KNOWLEDGE_SCHEMA_SQL = `
-- Project knowledge is a project-global catalog with its own head. It must
-- not follow projects.current_revision_id because Story, voice, visual-lock,
-- and other audit operations legitimately advance that legacy pointer.
CREATE TABLE IF NOT EXISTS project_knowledge_heads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  current_revision_id TEXT REFERENCES revisions(id),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS project_knowledge_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT PRIMARY KEY REFERENCES revisions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (revision_id, project_id)
    REFERENCES revisions(id, project_id)
) STRICT;

CREATE INDEX IF NOT EXISTS project_knowledge_revisions_scope_idx
  ON project_knowledge_revisions(project_id, created_at DESC, revision_id DESC);

CREATE TRIGGER IF NOT EXISTS projects_create_knowledge_head
AFTER INSERT ON projects
BEGIN
  INSERT OR IGNORE INTO project_knowledge_heads(project_id, current_revision_id, updated_at)
  VALUES (NEW.id, NULL, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS project_knowledge_heads_validate_update
BEFORE UPDATE OF current_revision_id ON project_knowledge_heads
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM project_knowledge_revisions
     WHERE project_id = NEW.project_id
       AND revision_id = NEW.current_revision_id
  ) THEN RAISE(ABORT, 'project knowledge head revision mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS project_knowledge_revisions_validate_insert
BEFORE INSERT ON project_knowledge_revisions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM revisions
     WHERE id = NEW.revision_id
       AND project_id = NEW.project_id
       AND json_extract(snapshot_json, '$.kind') = 'project.knowledge'
       AND json_extract(snapshot_json, '$.version') = 2
       AND json_type(snapshot_json, '$.knowledge') = 'object'
  ) THEN RAISE(ABORT, 'project knowledge revision scope mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS project_knowledge_revisions_no_update
BEFORE UPDATE ON project_knowledge_revisions
BEGIN
  SELECT RAISE(ABORT, 'project knowledge revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS project_knowledge_revisions_no_delete
BEFORE DELETE ON project_knowledge_revisions
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'project knowledge revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS project_knowledge_snapshot_no_update
BEFORE UPDATE ON revisions
WHEN EXISTS (
  SELECT 1 FROM project_knowledge_revisions
   WHERE revision_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'project knowledge snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS project_knowledge_snapshot_no_delete
BEFORE DELETE ON revisions
WHEN EXISTS (
  SELECT 1 FROM project_knowledge_revisions
   WHERE revision_id = OLD.id
)
AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'project knowledge snapshots are immutable');
END;

-- Every pre-v17 project receives an independent empty head. Old generic
-- snapshots are deliberately not guessed into this domain: their current
-- pointer may represent Story, voice, or visual-lock audit data.
INSERT OR IGNORE INTO project_knowledge_heads(project_id, current_revision_id, updated_at)
SELECT id, NULL, updated_at FROM projects;
`

const VOICE_PREVIEW_REVIEW_SCHEMA_SQL = `
-- A review is a zero-Provider, immutable human decision over one exact paid
-- preview result. Multiple rows may supersede an earlier decision without
-- rewriting history; idempotency prevents duplicate clicks from duplicating
-- the audit fact.
CREATE TABLE IF NOT EXISTS voice_preview_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('character', 'project_narrator')),
  subject_id TEXT NOT NULL,
  preview_job_id TEXT NOT NULL REFERENCES generation_jobs(id),
  preview_asset_id TEXT NOT NULL REFERENCES media_assets(id),
  preview_asset_checksum TEXT NOT NULL CHECK (
    length(preview_asset_checksum) = 64
    AND preview_asset_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  voice_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_config_revision INTEGER NOT NULL CHECK (provider_config_revision >= 1),
  catalog_fingerprint TEXT NOT NULL CHECK (
    length(catalog_fingerprint) = 64
    AND catalog_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  story_revision_id TEXT NOT NULL REFERENCES revisions(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  playback_completed_at TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reviewed_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key_hash)
) STRICT;

CREATE INDEX IF NOT EXISTS voice_preview_reviews_job_idx
  ON voice_preview_reviews(preview_job_id, reviewed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS voice_preview_reviews_subject_idx
  ON voice_preview_reviews(
    project_id, episode_id, subject_type, subject_id, reviewed_at DESC, id DESC
  );

CREATE TRIGGER IF NOT EXISTS voice_preview_reviews_validate_insert
BEFORE INSERT ON voice_preview_reviews
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM generation_jobs AS jobs
     WHERE jobs.id = NEW.preview_job_id
       AND jobs.project_id = NEW.project_id
       AND jobs.episode_id = NEW.episode_id
       AND jobs.status = 'succeeded'
       AND jobs.type = CASE NEW.subject_type
         WHEN 'character' THEN 'character.voice.preview'
         ELSE 'project.narrator.voice.preview'
       END
       AND jobs.resource_id = CASE NEW.subject_type
         WHEN 'character' THEN json_extract(jobs.input_json, '$.characterDatabaseId')
         ELSE NEW.project_id
       END
       AND NEW.subject_id = CASE NEW.subject_type
         WHEN 'character' THEN json_extract(jobs.input_json, '$.characterId')
         ELSE NEW.project_id
       END
       AND json_extract(jobs.input_json, '$.voiceId') = NEW.voice_id
       AND json_extract(jobs.input_json, '$.expectedCatalogFingerprint') = NEW.catalog_fingerprint
       AND json_extract(jobs.input_json, '$.expectedStoryRevisionId') = NEW.story_revision_id
       AND jobs.provider_id = NEW.provider_id
       AND jobs.model = NEW.model
       AND jobs.provider_config_revision = NEW.provider_config_revision
       AND json_extract(jobs.output_json, '$.asset.id') = NEW.preview_asset_id
  ) THEN RAISE(ABORT, 'voice preview review job binding mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM media_assets AS assets
     WHERE assets.id = NEW.preview_asset_id
       AND assets.project_id = NEW.project_id
       AND assets.episode_id = NEW.episode_id
       AND assets.generation_job_id = NEW.preview_job_id
       AND assets.status = 'ready'
       AND assets.checksum = NEW.preview_asset_checksum
  ) THEN RAISE(ABORT, 'voice preview review asset binding mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS voice_preview_reviews_no_update
BEFORE UPDATE ON voice_preview_reviews
BEGIN
  SELECT RAISE(ABORT, 'voice preview reviews are immutable');
END;

CREATE TRIGGER IF NOT EXISTS voice_preview_reviews_no_delete
BEFORE DELETE ON voice_preview_reviews
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'voice preview reviews are immutable');
END;
`

const VOICE_PREVIEW_PLAYBACK_EVIDENCE_COLUMN_SQL = `
-- v18 stored only playback_completed_at. Preserve those immutable rows with
-- an explicit legacy marker; every new insert must carry browser played-range
-- evidence that the service validates against the probed Asset duration.
ALTER TABLE voice_preview_reviews
  ADD COLUMN playback_evidence_json TEXT NOT NULL DEFAULT '{"version":"legacy-ended-v1"}'
  CHECK (json_valid(playback_evidence_json));
`

const VOICE_PREVIEW_PLAYBACK_EVIDENCE_SCHEMA_SQL = `
CREATE TRIGGER IF NOT EXISTS voice_preview_reviews_playback_evidence_validate_insert
BEFORE INSERT ON voice_preview_reviews
BEGIN
  SELECT CASE WHEN json_extract(NEW.playback_evidence_json, '$.version')
      != 'html-media-played-v1'
    OR json_type(NEW.playback_evidence_json, '$.durationSeconds') NOT IN ('integer', 'real')
    OR json_extract(NEW.playback_evidence_json, '$.durationSeconds') <= 0
    OR json_type(NEW.playback_evidence_json, '$.ranges') != 'array'
    OR json_array_length(NEW.playback_evidence_json, '$.ranges') NOT BETWEEN 1 AND 64
  THEN RAISE(ABORT, 'voice preview review playback evidence invalid') END;
END;
`

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key)
  return SENSITIVE_JSON_KEYS.has(normalized)
    || normalized.endsWith('apikey')
    || normalized.endsWith('clientsecret')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('secretkey')
    || normalized.endsWith('subscriptionkey')
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('refreshtoken')
}

function validateProviderBaseUrl(value: string | null): string | null {
  if (value === null) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Provider baseUrl must be an absolute HTTP(S) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Provider baseUrl must use HTTP or HTTPS')
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('Provider baseUrl must not contain credentials; store them in Keychain')
  }
  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveKey(key)) {
      throw new TypeError('Provider baseUrl must not contain secret query parameters; store them in Keychain')
    }
  }
  return value
}

function providerGenerationOptions(config: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !PROVIDER_RUNTIME_CONFIG_KEYS.has(key)),
  ) as JsonObject
}

function sameCredentialReference(left: KeychainReference | null, right: KeychainReference | null): boolean {
  return left?.service === right?.service && left?.account === right?.account
}

function validateJson(value: unknown, path = '$', seen = new Set<unknown>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    return
  }
  if (typeof value !== 'object') throw new TypeError(`${path} is not JSON serializable`)
  if (seen.has(value)) throw new TypeError(`${path} contains a circular reference`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJson(item, `${path}[${index}]`, seen))
  } else {
    if (!isPlainObject(value)) throw new TypeError(`${path} must contain only plain JSON objects`)
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new TypeError(`${path}.${key} is not an allowed JSON key`)
      }
      if (isSensitiveKey(key)) {
        throw new TypeError(`${path}.${key} looks like a secret and must be stored in Keychain`)
      }
      validateJson(item, `${path}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function serializeJson(value: JsonValue): string {
  validateJson(value)
  return JSON.stringify(value)
}

function serializeJsonObject(value: unknown, label: string): string {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain JSON object`)
  return serializeJson(value as JsonObject)
}

function sanitizeLegacyJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(sanitizeLegacyJson)
  if (!isPlainObject(value)) return null

  const sanitized: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || isSensitiveKey(key)) continue
    sanitized[key] = sanitizeLegacyJson(item)
  }
  return sanitized
}

function parseJsonObject(value: unknown, column: string): JsonObject {
  if (typeof value !== 'string') throw new Error(`Database column ${column} is not JSON text`)
  const parsed: unknown = JSON.parse(value)
  if (!isPlainObject(parsed)) throw new Error(`Database column ${column} is not a JSON object`)
  return parsed as JsonObject
}

function optionalJsonObject(value: unknown, column: string): JsonObject | null {
  return value === null || value === undefined ? null : parseJsonObject(value, column)
}

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

function nullableNumber(row: SqlRow, column: string): number | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== 'number') throw new Error(`Database column ${column} is not nullable numeric`)
  return value
}

function asProject(row: SqlRow): ProjectRecord {
  return {
    id: requiredString(row, 'id'),
    title: requiredString(row, 'title'),
    currentEpisodeId: nullableString(row, 'current_episode_id'),
    currentRevisionId: nullableString(row, 'current_revision_id'),
    settings: parseJsonObject(row.settings_json, 'settings_json'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
  }
}

function asRevision(row: SqlRow): RevisionRecord {
  return {
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'project_id'),
    parentRevisionId: nullableString(row, 'parent_revision_id'),
    summary: requiredString(row, 'summary'),
    snapshot: parseJsonObject(row.snapshot_json, 'snapshot_json'),
    createdAt: requiredString(row, 'created_at'),
  }
}

function asMediaAsset(row: SqlRow): MediaAssetRecord {
  return {
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: nullableString(row, 'episode_id'),
    kind: requiredString(row, 'kind'),
    version: requiredNumber(row, 'version'),
    status: requiredString(row, 'status'),
    filePath: nullableString(row, 'file_path'),
    mimeType: nullableString(row, 'mime_type'),
    width: nullableNumber(row, 'width'),
    height: nullableNumber(row, 'height'),
    durationSeconds: nullableNumber(row, 'duration_seconds'),
    checksum: nullableString(row, 'checksum'),
    source: requiredString(row, 'source'),
    providerId: nullableString(row, 'provider_id'),
    generationJobId: nullableString(row, 'generation_job_id'),
    generationParameters: parseJsonObject(row.generation_parameters_json, 'generation_parameters_json'),
    sourceRevisionId: nullableString(row, 'source_revision_id'),
    parentAssetId: nullableString(row, 'parent_asset_id'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
  }
}

function asGenerationJob(row: SqlRow): GenerationJobRecord {
  const status = requiredString(row, 'status') as JobStatus
  if (!JOB_STATUSES.has(status)) throw new Error(`Database contains an invalid job status: ${status}`)
  return {
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: nullableString(row, 'episode_id'),
    pipelineRunId: nullableString(row, 'pipeline_run_id'),
    type: requiredString(row, 'type'),
    status,
    progress: requiredNumber(row, 'progress'),
    resourceType: nullableString(row, 'resource_type'),
    resourceId: nullableString(row, 'resource_id'),
    providerId: nullableString(row, 'provider_id'),
    model: nullableString(row, 'model'),
    providerConfigRevision: nullableNumber(row, 'provider_config_revision'),
    externalTaskId: nullableString(row, 'external_task_id'),
    idempotencyKey: nullableString(row, 'idempotency_key'),
    retryOf: nullableString(row, 'retry_of'),
    attempt: requiredNumber(row, 'attempt'),
    input: parseJsonObject(row.input_json, 'input_json'),
    providerState: parseJsonObject(row.provider_state_json, 'provider_state_json'),
    progressDetail: parseJsonObject(row.progress_detail_json, 'progress_detail_json'),
    output: optionalJsonObject(row.output_json, 'output_json'),
    error: optionalJsonObject(row.error_json, 'error_json'),
    cost: optionalJsonObject(row.cost_json, 'cost_json'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
    startedAt: nullableString(row, 'started_at'),
    completedAt: nullableString(row, 'completed_at'),
  }
}

function asPipelineRun(row: SqlRow): PipelineRunRecord {
  const status = requiredString(row, 'status') as PipelineRunStatus
  if (!PIPELINE_RUN_STATUSES.has(status)) {
    throw new Error(`Database contains an invalid pipeline run status: ${status}`)
  }
  return {
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'project_id'),
    episodeId: nullableString(row, 'episode_id'),
    idempotencyKey: nullableString(row, 'idempotency_key'),
    sourceRevisionId: nullableString(row, 'source_revision_id'),
    status,
    progress: requiredNumber(row, 'progress'),
    steps: parseJsonObject(row.steps_json, 'steps_json'),
    error: optionalJsonObject(row.error_json, 'error_json'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
    completedAt: nullableString(row, 'completed_at'),
  }
}

function asProviderConnection(row: SqlRow): ProviderConnectionRecord {
  const service = nullableString(row, 'keychain_service')
  const account = nullableString(row, 'keychain_account')
  return {
    id: requiredString(row, 'id'),
    kind: requiredString(row, 'kind') as ProviderKind,
    adapter: requiredString(row, 'adapter'),
    displayName: requiredString(row, 'display_name'),
    baseUrl: nullableString(row, 'base_url'),
    defaultModel: nullableString(row, 'default_model'),
    authMode: requiredString(row, 'auth_mode') as ProviderAuthMode,
    credentialReference: service && account ? { service, account } : null,
    config: parseJsonObject(row.config_json, 'config_json'),
    configRevision: requiredNumber(row, 'config_revision'),
    enabled: requiredNumber(row, 'enabled') === 1,
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
  }
}

function asProviderConnectionVersion(row: SqlRow): ProviderConnectionVersionRecord {
  const service = nullableString(row, 'keychain_service')
  const account = nullableString(row, 'keychain_account')
  return {
    providerId: requiredString(row, 'provider_id'),
    configRevision: requiredNumber(row, 'config_revision'),
    kind: requiredString(row, 'kind') as ProviderKind,
    adapter: requiredString(row, 'adapter'),
    baseUrl: nullableString(row, 'base_url'),
    model: nullableString(row, 'model'),
    authMode: requiredString(row, 'auth_mode') as ProviderAuthMode,
    credentialReference: service && account ? { service, account } : null,
    executionConfig: parseJsonObject(row.execution_config_json, 'execution_config_json'),
    createdAt: requiredString(row, 'created_at'),
  }
}

function normalizeLimit(value: number | undefined, fallback = 100): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) throw new RangeError('limit must be a positive integer')
  return Math.min(value, 1_000)
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isInteger(value) || value < 0) throw new RangeError('offset must be a non-negative integer')
  return value
}

function normalizeProgress(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError('job progress must be between 0 and 100')
  }
  return value
}

function normalizePipelineProgress(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError('pipeline run progress must be between 0 and 100')
  }
  return value
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`)
  return value
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fallback
  return new Date(value).toISOString()
}

function parseLegacyDuration(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value !== 'string') return 0
  const parsed = Number.parseFloat(value.replace(/s$/i, ''))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function legacyLocalFilePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/generated/')) return null
  const normalized = posix.normalize(value)
  if (!normalized.startsWith('/generated/') || normalized.includes('/../')) return null
  const fileName = normalized.slice('/generated/'.length)
  if (!fileName || fileName.includes('/')) return null
  return `generated/${fileName}`
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : null
}

function asLegacyState(value: unknown): { version: number; project: JsonObject; jobs: unknown[] } {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.project) || !Array.isArray(value.jobs)) {
    throw new Error('Legacy state.json is not a supported version 1 state file')
  }
  return { version: 1, project: value.project as JsonObject, jobs: value.jobs }
}

function schemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as SqlRow | undefined
  const current = row?.user_version
  if (typeof current !== 'number') throw new Error('Unable to read SQLite user_version')
  return current
}

interface MediaIndexBackupPayload {
  version: 1
  sourceSchemaVersion: number
  targetSchemaVersion: number
  sqliteBackupFile: string
  createdAt: string
  assets: Array<{
    id: string
    projectId: string
    episodeId: string | null
    kind: string
    version: number
    status: string
    filePath: string | null
    mimeType: string | null
    width: number | null
    height: number | null
    durationSeconds: number | null
    checksum: string | null
    source: string
    providerId: string | null
    generationJobId: string | null
    sourceRevisionId: string | null
    parentAssetId: string | null
    createdAt: string
    updatedAt: string
  }>
}

interface MediaIndexBackupEnvelope {
  payload: MediaIndexBackupPayload
  payloadSha256: string
}

function nullableMediaIndexString(row: SqlRow, key: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`Media index column ${key} is invalid`)
  return value
}

function nullableMediaIndexNumber(row: SqlRow, key: string): number | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Media index column ${key} is invalid`)
  }
  return value
}

function requiredMediaIndexString(row: SqlRow, key: string): string {
  const value = nullableMediaIndexString(row, key)
  if (value === null) throw new Error(`Media index column ${key} is required`)
  return value
}

function requiredMediaIndexNumber(row: SqlRow, key: string): number {
  const value = nullableMediaIndexNumber(row, key)
  if (value === null) throw new Error(`Media index column ${key} is required`)
  return value
}

/**
 * Persist a secret-free, independently readable media inventory beside the
 * physical migration backup. Operators can therefore recover Asset identity,
 * checksums and file locations even when their only SQLite tooling is broken.
 */
function verifiedMediaIndexBackup(input: {
  database: DatabaseSync
  directory: string
  sqliteBackupPath: string
  currentVersion: number
  targetVersion: number
  timestamp: string
  backupId: string
}): string {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 })
  const baseName = `media-index-v${input.currentVersion}-before-v${input.targetVersion}-${input.timestamp}-${input.backupId}.json`
  const outputPath = resolve(input.directory, baseName)
  const temporaryPath = `${outputPath}.tmp`
  const rows = input.database.prepare(`
    SELECT
      id, project_id, episode_id, kind, version, status, file_path, mime_type,
      width, height, duration_seconds, checksum, source, provider_id,
      generation_job_id, source_revision_id,
      parent_asset_id, created_at, updated_at
    FROM media_assets
    ORDER BY id ASC
  `).all() as SqlRow[]
  const payload: MediaIndexBackupPayload = {
    version: 1,
    sourceSchemaVersion: input.currentVersion,
    targetSchemaVersion: input.targetVersion,
    sqliteBackupFile: basename(input.sqliteBackupPath),
    createdAt: new Date().toISOString(),
    assets: rows.map((row) => ({
      id: requiredMediaIndexString(row, 'id'),
      projectId: requiredMediaIndexString(row, 'project_id'),
      episodeId: nullableMediaIndexString(row, 'episode_id'),
      kind: requiredMediaIndexString(row, 'kind'),
      version: requiredMediaIndexNumber(row, 'version'),
      status: requiredMediaIndexString(row, 'status'),
      filePath: nullableMediaIndexString(row, 'file_path'),
      mimeType: nullableMediaIndexString(row, 'mime_type'),
      width: nullableMediaIndexNumber(row, 'width'),
      height: nullableMediaIndexNumber(row, 'height'),
      durationSeconds: nullableMediaIndexNumber(row, 'duration_seconds'),
      checksum: nullableMediaIndexString(row, 'checksum'),
      source: requiredMediaIndexString(row, 'source'),
      providerId: nullableMediaIndexString(row, 'provider_id'),
      generationJobId: nullableMediaIndexString(row, 'generation_job_id'),
      sourceRevisionId: nullableMediaIndexString(row, 'source_revision_id'),
      parentAssetId: nullableMediaIndexString(row, 'parent_asset_id'),
      createdAt: requiredMediaIndexString(row, 'created_at'),
      updatedAt: requiredMediaIndexString(row, 'updated_at'),
    })),
  }
  const serializedPayload = JSON.stringify(payload)
  const envelope: MediaIndexBackupEnvelope = {
    payload,
    payloadSha256: createHash('sha256').update(serializedPayload).digest('hex'),
  }
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    chmodSync(temporaryPath, 0o600)
    const verified = JSON.parse(readFileSync(temporaryPath, 'utf8')) as MediaIndexBackupEnvelope
    if (!isPlainObject(verified)
      || !isPlainObject(verified.payload)
      || typeof verified.payloadSha256 !== 'string'
      || createHash('sha256').update(JSON.stringify(verified.payload)).digest('hex') !== verified.payloadSha256
      || verified.payload.sourceSchemaVersion !== input.currentVersion
      || verified.payload.targetSchemaVersion !== input.targetVersion
      || verified.payload.sqliteBackupFile !== basename(input.sqliteBackupPath)
      || !Array.isArray(verified.payload.assets)
      || verified.payload.assets.length !== rows.length) {
      throw new Error('Media index backup verification failed')
    }
    renameSync(temporaryPath, outputPath)
    return outputPath
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    rmSync(outputPath, { force: true })
    throw new Error('Unable to create and verify the pre-migration media index backup', { cause: error })
  }
}

function verifiedPreMigrationBackup(
  database: DatabaseSync,
  databasePath: string,
  currentVersion: number,
  targetVersion: number,
  backupDirectory: string | false | undefined,
): string | null {
  if (databasePath === ':memory:' || currentVersion < 1 || currentVersion >= targetVersion
    || backupDirectory === false) return null
  const backupRoot = resolve(backupDirectory ?? dirname(databasePath))
  const directory = backupDirectory ? backupRoot : resolve(backupRoot, 'backups')
  const mediaIndexDirectory = resolve(backupRoot, 'media-index-backups')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupId = randomUUID()
  const fileName = `manju-v${currentVersion}-before-v${targetVersion}-${timestamp}-${backupId}.sqlite`
  const backupPath = resolve(directory, fileName)
  let mediaIndexPath: string | null = null
  try {
    // VACUUM INTO is a synchronous, transactionally consistent snapshot and
    // includes committed WAL content without copying live sidecar files.
    database.prepare('VACUUM INTO ?').run(backupPath)
    chmodSync(backupPath, 0o600)
    const verification = new DatabaseSync(backupPath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    })
    try {
      const quickCheck = verification.prepare('PRAGMA quick_check').get() as SqlRow | undefined
      if (quickCheck?.quick_check !== 'ok') throw new Error('SQLite backup quick_check failed')
      if (schemaVersion(verification) !== currentVersion) {
        throw new Error('SQLite backup schema version does not match the source')
      }
      mediaIndexPath = verifiedMediaIndexBackup({
        database: verification,
        directory: mediaIndexDirectory,
        sqliteBackupPath: backupPath,
        currentVersion,
        targetVersion,
        timestamp,
        backupId,
      })
    } finally {
      verification.close()
    }
    return backupPath
  } catch (error) {
    rmSync(backupPath, { force: true })
    if (mediaIndexPath) rmSync(mediaIndexPath, { force: true })
    throw new Error('Unable to create and verify the pre-migration SQLite backup', { cause: error })
  }
}

function migrate(database: DatabaseSync): void {
  const current = schemaVersion(database)
  if (current > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Database schema ${current} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`)
  }
  if (current === DATABASE_SCHEMA_VERSION) return

  database.exec('BEGIN IMMEDIATE')
  try {
    if (current < 1) database.exec(SCHEMA_SQL)
    if (current < 2) {
      database.exec(`
        ALTER TABLE episodes
          ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json));
        ALTER TABLE episodes
          ADD COLUMN source_revision_id TEXT REFERENCES revisions(id) ON DELETE SET NULL;
        CREATE INDEX episodes_source_revision_idx ON episodes(source_revision_id);
      `)
    }
    if (current < 3) {
      database.exec(PROVIDER_VERSION_SCHEMA_SQL)
      // v2 did not retain historical profiles. Preserve every revision still
      // referenced by a job, plus revision 1 and the current revision, using
      // the only safe configuration available at migration time. All future
      // revisions are captured exactly when they are created.
      database.exec(`
        WITH desired(provider_id, config_revision) AS (
          SELECT id, 1 FROM provider_connections
          UNION
          SELECT id, config_revision FROM provider_connections
          UNION
          SELECT provider_id, provider_config_revision
            FROM generation_jobs
           WHERE provider_id IS NOT NULL AND provider_config_revision IS NOT NULL
        )
        INSERT OR IGNORE INTO provider_connection_versions (
          provider_id, config_revision, kind, adapter, base_url, model, auth_mode,
          keychain_service, keychain_account, execution_config_json, created_at
        )
        SELECT
          desired.provider_id,
          desired.config_revision,
          provider.kind,
          provider.adapter,
          provider.base_url,
          provider.default_model,
          provider.auth_mode,
          provider.keychain_service,
          provider.keychain_account,
          json_set(
            json_remove(
              provider.config_json,
              '$.isDefault',
              '$.lastTestedAt',
              '$.lastTestStatus',
              '$.lastTestMessage'
            ),
            '$.__migrationProvenance',
            'v2-approximation'
          ),
          provider.updated_at
        FROM desired
        JOIN provider_connections AS provider ON provider.id = desired.provider_id;
      `)
    }
    if (current < 4) database.exec(TIMELINE_DOCUMENT_SCHEMA_SQL)
    if (current < 5) database.exec(QUALITY_REPORT_BINDING_SCHEMA_SQL)
    if (current < 6) database.exec(PIPELINE_RUN_SCHEMA_SQL)
    if (current < 7) database.exec(TIMELINE_AUTO_EDIT_SCHEMA_SQL)
    if (current < 8) database.exec(TIMELINE_AUTO_EDIT_DELETE_GUARD_SCHEMA_SQL)
    if (current < 9) database.exec(STORY_AND_CHARACTER_REFERENCE_SCOPE_SCHEMA_SQL)
    if (current < 10) database.exec(STORY_SCOPED_REVISION_IMMUTABILITY_SCHEMA_SQL)
    if (current < 11) database.exec(RELEASE_REVIEW_SCHEMA_SQL)
    if (current < 12) database.exec(TIMELINE_REVISION_RESTORE_SCHEMA_SQL)
    if (current < 13) database.exec(SHOT_MEDIA_REVIEW_SCHEMA_SQL)
    if (current >= 13 && current < 14) {
      // v14 tightens the existing immutable audit trigger. Recreate it in the
      // same migration transaction; the verified v13 physical/media backups
      // have already completed before this transaction begins.
      database.exec('DROP TRIGGER IF EXISTS shot_media_review_validate_insert')
      database.exec(SHOT_MEDIA_REVIEW_SCHEMA_SQL)
    }
    if (current < 14) database.exec(TIMELINE_MEDIA_AUTHORITY_RECEIPT_SCHEMA_SQL)
    if (current < 15) database.exec(ASSET_IDENTITY_SCHEMA_SQL)
    if (current < 16) database.exec(PRODUCTION_ASSET_MANIFEST_SCHEMA_SQL)
    if (current < 17) database.exec(PROJECT_KNOWLEDGE_SCHEMA_SQL)
    if (current < 18) database.exec(VOICE_PREVIEW_REVIEW_SCHEMA_SQL)
    if (current < 19) {
      const evidenceColumn = database.prepare(`
        SELECT name FROM pragma_table_info('voice_preview_reviews')
         WHERE name = 'playback_evidence_json'
      `).get()
      if (!evidenceColumn) database.exec(VOICE_PREVIEW_PLAYBACK_EVIDENCE_COLUMN_SQL)
      database.exec(VOICE_PREVIEW_PLAYBACK_EVIDENCE_SCHEMA_SQL)
    }
    database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export class ManjuDatabase {
  private closed = false
  private transactionDepth = 0
  private savepointSequence = 0

  constructor(
    private readonly database: DatabaseSync,
    readonly path: string,
    private readonly now: () => string,
    private readonly idFactory: () => string,
  ) {}

  get schemaVersion(): number {
    this.assertOpen()
    const row = this.database.prepare('PRAGMA user_version').get() as SqlRow
    return requiredNumber(row, 'user_version')
  }

  health(): DatabaseHealth {
    this.assertOpen()
    const foreignKeys = this.database.prepare('PRAGMA foreign_keys').get() as SqlRow
    const journalMode = this.database.prepare('PRAGMA journal_mode').get() as SqlRow
    const quickCheck = this.database.prepare('PRAGMA quick_check').get() as SqlRow
    return {
      schemaVersion: this.schemaVersion,
      foreignKeys: requiredNumber(foreignKeys, 'foreign_keys') === 1,
      journalMode: requiredString(journalMode, 'journal_mode'),
      quickCheck: requiredString(quickCheck, 'quick_check'),
    }
  }

  withSql<T>(callback: (sql: DatabaseSqlAccess) => T): T {
    this.assertOpen()
    const access: DatabaseSqlAccess = {
      get: (statement, ...bindings) => this.database.prepare(statement).get(...bindings) as SqlRow | undefined,
      all: (statement, ...bindings) => this.database.prepare(statement).all(...bindings) as SqlRow[],
      run: (statement, ...bindings) => ({
        changes: Number(this.database.prepare(statement).run(...bindings).changes),
      }),
    }
    const result = callback(access)
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new TypeError('ManjuDatabase.withSql callback must be synchronous')
    }
    return result
  }

  close(): void {
    if (this.closed) return
    if (this.transactionDepth > 0) throw new Error('Cannot close database during a transaction')
    this.database.close()
    this.closed = true
  }

  transaction<T>(callback: (database: ManjuDatabase) => T): T {
    this.assertOpen()
    const outermost = this.transactionDepth === 0
    const savepoint = `manju_nested_${++this.savepointSequence}`
    this.database.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    const previousDepth = this.transactionDepth
    this.transactionDepth = previousDepth + 1
    try {
      const result = callback(this)
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new TypeError('ManjuDatabase.transaction callback must be synchronous')
      }
      this.database.exec(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      try {
        if (outermost) {
          this.database.exec('ROLLBACK')
        } else {
          this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          this.database.exec(`RELEASE SAVEPOINT ${savepoint}`)
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Database transaction failed and could not be rolled back cleanly',
        )
      }
      throw error
    } finally {
      // In particular, COMMIT can fail while checking a deferred foreign key.
      // Restore depth exactly once so the next transaction is not mistaken for
      // a nested savepoint and close() does not see a phantom active scope.
      this.transactionDepth = previousDepth
    }
  }

  createProject(input: CreateProjectInput): ProjectRecord {
    this.assertOpen()
    const id = input.id ?? this.idFactory()
    this.assertProjectReference(id, 'episodes', input.currentEpisodeId, 'Episode')
    this.assertProjectReference(id, 'revisions', input.currentRevisionId, 'Revision')
    const createdAt = input.createdAt ?? this.now()
    const updatedAt = input.updatedAt ?? createdAt
    this.database.prepare(`
      INSERT INTO projects (
        id, title, current_episode_id, current_revision_id, settings_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title.trim(),
      input.currentEpisodeId ?? null,
      input.currentRevisionId ?? null,
      serializeJson(input.settings ?? {}),
      createdAt,
      updatedAt,
    )
    return this.requireProject(id)
  }

  getProject(id: string): ProjectRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as SqlRow | undefined
    return row ? asProject(row) : undefined
  }

  listProjects(options: { limit?: number; offset?: number } = {}): ProjectRecord[] {
    this.assertOpen()
    return (this.database.prepare(`
      SELECT * FROM projects ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?
    `).all(normalizeLimit(options.limit), normalizeOffset(options.offset)) as SqlRow[]).map(asProject)
  }

  updateProject(id: string, input: UpdateProjectInput): ProjectRecord | undefined {
    this.assertOpen()
    if (!this.getProject(id)) return undefined
    this.assertProjectReference(id, 'episodes', input.currentEpisodeId, 'Episode')
    this.assertProjectReference(id, 'revisions', input.currentRevisionId, 'Revision')
    const fields: Array<[string, SQLInputValue]> = []
    if (input.title !== undefined) fields.push(['title', input.title.trim()])
    if (input.currentEpisodeId !== undefined) fields.push(['current_episode_id', input.currentEpisodeId])
    if (input.currentRevisionId !== undefined) fields.push(['current_revision_id', input.currentRevisionId])
    if (input.settings !== undefined) fields.push(['settings_json', serializeJson(input.settings)])
    fields.push(['updated_at', this.now()])
    this.runUpdate('projects', id, fields)
    return this.getProject(id)
  }

  deleteProject(id: string): boolean {
    this.assertOpen()
    return Number(this.database.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0
  }

  createRevision(input: CreateRevisionInput): RevisionRecord {
    this.assertOpen()
    this.assertProjectReference(input.projectId, 'revisions', input.parentRevisionId, 'Parent revision')
    const id = input.id ?? this.idFactory()
    this.database.prepare(`
      INSERT INTO revisions (id, project_id, parent_revision_id, summary, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.parentRevisionId ?? null,
      input.summary,
      serializeJson(input.snapshot),
      input.createdAt ?? this.now(),
    )
    return this.requireRevision(id)
  }

  getRevision(id: string): RevisionRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT * FROM revisions WHERE id = ?').get(id) as SqlRow | undefined
    return row ? asRevision(row) : undefined
  }

  listRevisions(projectId: string, options: { limit?: number; offset?: number } = {}): RevisionRecord[] {
    this.assertOpen()
    return (this.database.prepare(`
      SELECT * FROM revisions WHERE project_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(projectId, normalizeLimit(options.limit), normalizeOffset(options.offset)) as SqlRow[]).map(asRevision)
  }

  updateRevision(id: string, input: UpdateRevisionInput): RevisionRecord | undefined {
    this.assertOpen()
    const current = this.getRevision(id)
    if (!current) return undefined
    this.assertProjectReference(current.projectId, 'revisions', input.parentRevisionId, 'Parent revision')
    const fields: Array<[string, SQLInputValue]> = []
    if (input.parentRevisionId !== undefined) fields.push(['parent_revision_id', input.parentRevisionId])
    if (input.summary !== undefined) fields.push(['summary', input.summary])
    if (input.snapshot !== undefined) fields.push(['snapshot_json', serializeJson(input.snapshot)])
    if (fields.length > 0) this.runUpdate('revisions', id, fields)
    return this.getRevision(id)
  }

  deleteRevision(id: string): boolean {
    this.assertOpen()
    return Number(this.database.prepare('DELETE FROM revisions WHERE id = ?').run(id).changes) > 0
  }

  createMediaAsset(input: CreateMediaAssetInput): MediaAssetRecord {
    this.assertOpen()
    this.assertProjectReference(input.projectId, 'episodes', input.episodeId, 'Episode')
    this.assertProjectReference(input.projectId, 'generation_jobs', input.generationJobId, 'Generation job')
    this.assertProjectReference(input.projectId, 'revisions', input.sourceRevisionId, 'Source revision')
    this.assertProjectReference(input.projectId, 'media_assets', input.parentAssetId, 'Parent asset')
    const id = input.id ?? this.idFactory()
    const createdAt = input.createdAt ?? this.now()
    const updatedAt = input.updatedAt ?? createdAt
    this.database.prepare(`
      INSERT INTO media_assets (
        id, project_id, episode_id, kind, version, status, file_path, mime_type, width, height,
        duration_seconds, checksum, source, provider_id, generation_job_id,
        generation_parameters_json, source_revision_id, parent_asset_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.episodeId ?? null,
      input.kind,
      normalizePositiveInteger(input.version ?? 1, 'asset version'),
      input.status ?? 'ready',
      input.filePath ?? null,
      input.mimeType ?? null,
      input.width ?? null,
      input.height ?? null,
      input.durationSeconds ?? null,
      input.checksum ?? null,
      input.source,
      input.providerId ?? null,
      input.generationJobId ?? null,
      serializeJson(input.generationParameters ?? {}),
      input.sourceRevisionId ?? null,
      input.parentAssetId ?? null,
      createdAt,
      updatedAt,
    )
    return this.requireMediaAsset(id)
  }

  getMediaAsset(id: string): MediaAssetRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT * FROM media_assets WHERE id = ?').get(id) as SqlRow | undefined
    return row ? asMediaAsset(row) : undefined
  }

  listMediaAssets(
    options: {
      projectId: string
      episodeId?: string
      includeProjectAssets?: boolean
      kind?: string
      limit?: number
      offset?: number
    },
  ): MediaAssetRecord[] {
    this.assertOpen()
    const clauses = ['project_id = ?']
    const bindings: SQLInputValue[] = [options.projectId]
    if (options.episodeId !== undefined) {
      clauses.push(options.includeProjectAssets === true
        ? '(episode_id = ? OR episode_id IS NULL)'
        : 'episode_id = ?')
      bindings.push(options.episodeId)
    }
    if (options.kind !== undefined) {
      clauses.push('kind = ?')
      bindings.push(options.kind)
    }
    bindings.push(normalizeLimit(options.limit), normalizeOffset(options.offset))
    const rows = this.database.prepare(`
      SELECT * FROM media_assets WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...bindings) as SqlRow[]
    return rows.map(asMediaAsset)
  }

  updateMediaAsset(id: string, input: UpdateMediaAssetInput): MediaAssetRecord | undefined {
    this.assertOpen()
    const current = this.getMediaAsset(id)
    if (!current) return undefined
    this.assertProjectReference(current.projectId, 'episodes', input.episodeId, 'Episode')
    this.assertProjectReference(current.projectId, 'generation_jobs', input.generationJobId, 'Generation job')
    this.assertProjectReference(current.projectId, 'revisions', input.sourceRevisionId, 'Source revision')
    this.assertProjectReference(current.projectId, 'media_assets', input.parentAssetId, 'Parent asset')
    const fields: Array<[string, SQLInputValue]> = []
    if (input.episodeId !== undefined) fields.push(['episode_id', input.episodeId])
    if (input.kind !== undefined) fields.push(['kind', input.kind])
    if (input.version !== undefined) fields.push(['version', normalizePositiveInteger(input.version, 'asset version')])
    if (input.status !== undefined) fields.push(['status', input.status])
    if (input.filePath !== undefined) fields.push(['file_path', input.filePath])
    if (input.mimeType !== undefined) fields.push(['mime_type', input.mimeType])
    if (input.width !== undefined) fields.push(['width', input.width])
    if (input.height !== undefined) fields.push(['height', input.height])
    if (input.durationSeconds !== undefined) fields.push(['duration_seconds', input.durationSeconds])
    if (input.checksum !== undefined) fields.push(['checksum', input.checksum])
    if (input.source !== undefined) fields.push(['source', input.source])
    if (input.providerId !== undefined) fields.push(['provider_id', input.providerId])
    if (input.generationJobId !== undefined) fields.push(['generation_job_id', input.generationJobId])
    if (input.generationParameters !== undefined) {
      fields.push(['generation_parameters_json', serializeJson(input.generationParameters)])
    }
    if (input.sourceRevisionId !== undefined) fields.push(['source_revision_id', input.sourceRevisionId])
    if (input.parentAssetId !== undefined) fields.push(['parent_asset_id', input.parentAssetId])
    fields.push(['updated_at', this.now()])
    this.runUpdate('media_assets', id, fields)
    return this.getMediaAsset(id)
  }

  deleteMediaAsset(id: string): boolean {
    this.assertOpen()
    return Number(this.database.prepare('DELETE FROM media_assets WHERE id = ?').run(id).changes) > 0
  }

  createPipelineRun(input: CreatePipelineRunInput): PipelineRunRecord {
    this.assertOpen()
    this.assertProjectReference(input.projectId, 'episodes', input.episodeId, 'Episode')
    this.assertProjectReference(input.projectId, 'revisions', input.sourceRevisionId, 'Source revision')
    const id = input.id ?? this.idFactory()
    const createdAt = input.createdAt ?? this.now()
    const updatedAt = input.updatedAt ?? createdAt
    const status = input.status ?? 'queued'
    if (!PIPELINE_RUN_STATUSES.has(status)) {
      throw new TypeError(`Unsupported pipeline run status: ${status}`)
    }
    this.database.prepare(`
      INSERT INTO pipeline_runs (
        id, project_id, episode_id, idempotency_key, source_revision_id, status,
        progress, steps_json, error_json, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.episodeId ?? null,
      input.idempotencyKey ?? null,
      input.sourceRevisionId ?? null,
      status,
      normalizePipelineProgress(input.progress ?? 0),
      serializeJsonObject(input.steps ?? {}, 'pipeline run steps'),
      input.error === undefined || input.error === null
        ? null
        : serializeJsonObject(input.error, 'pipeline run error'),
      createdAt,
      updatedAt,
      input.completedAt ?? null,
    )
    return this.requirePipelineRun(id)
  }

  getPipelineRun(id: string): PipelineRunRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id) as
      | SqlRow
      | undefined
    return row ? asPipelineRun(row) : undefined
  }

  findPipelineRunByIdempotencyKey(
    projectId: string,
    idempotencyKey: string,
  ): PipelineRunRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT * FROM pipeline_runs WHERE project_id = ? AND idempotency_key = ?
    `).get(projectId, idempotencyKey) as SqlRow | undefined
    return row ? asPipelineRun(row) : undefined
  }

  listPipelineRuns(options: ListPipelineRunsOptions = {}): PipelineRunRecord[] {
    this.assertOpen()
    const clauses: string[] = []
    const bindings: SQLInputValue[] = []
    if (options.projectId !== undefined) {
      clauses.push('project_id = ?')
      bindings.push(options.projectId)
    }
    if (options.episodeId !== undefined) {
      clauses.push('episode_id = ?')
      bindings.push(options.episodeId)
    }
    if (options.status !== undefined) {
      if (!PIPELINE_RUN_STATUSES.has(options.status)) {
        throw new TypeError(`Unsupported pipeline run status: ${options.status}`)
      }
      clauses.push('status = ?')
      bindings.push(options.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    bindings.push(normalizeLimit(options.limit), normalizeOffset(options.offset))
    const rows = this.database.prepare(`
      SELECT * FROM pipeline_runs ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...bindings) as SqlRow[]
    return rows.map(asPipelineRun)
  }

  updatePipelineRun(id: string, input: UpdatePipelineRunInput): PipelineRunRecord | undefined {
    this.assertOpen()
    if (!this.getPipelineRun(id)) return undefined
    const fields: Array<[string, SQLInputValue]> = []
    if (input.status !== undefined) {
      if (!PIPELINE_RUN_STATUSES.has(input.status)) {
        throw new TypeError(`Unsupported pipeline run status: ${input.status}`)
      }
      fields.push(['status', input.status])
    }
    if (input.progress !== undefined) {
      fields.push(['progress', normalizePipelineProgress(input.progress)])
    }
    if (input.steps !== undefined) {
      fields.push(['steps_json', serializeJsonObject(input.steps, 'pipeline run steps')])
    }
    if (input.error !== undefined) {
      fields.push([
        'error_json',
        input.error === null ? null : serializeJsonObject(input.error, 'pipeline run error'),
      ])
    }
    if (input.completedAt !== undefined) fields.push(['completed_at', input.completedAt])
    fields.push(['updated_at', this.now()])
    this.runUpdate('pipeline_runs', id, fields)
    return this.getPipelineRun(id)
  }

  createGenerationJob(input: CreateGenerationJobInput): GenerationJobRecord {
    this.assertOpen()
    this.assertProjectReference(input.projectId, 'episodes', input.episodeId, 'Episode')
    this.assertProjectReference(input.projectId, 'pipeline_runs', input.pipelineRunId, 'Pipeline run')
    this.assertProjectReference(input.projectId, 'generation_jobs', input.retryOf, 'Retry source job')
    const providerBinding = this.resolveProviderBinding(
      input.providerId ?? null,
      input.providerConfigRevision ?? null,
      input.model ?? null,
    )
    const id = input.id ?? this.idFactory()
    const createdAt = input.createdAt ?? this.now()
    const updatedAt = input.updatedAt ?? createdAt
    const status = input.status ?? 'queued'
    if (!JOB_STATUSES.has(status)) throw new TypeError(`Unsupported job status: ${status}`)
    const cost = providerBinding.kind === null
      ? input.cost
      : withProviderPlatformCostPolicy(providerBinding.kind, input.cost)
    this.database.prepare(`
      INSERT INTO generation_jobs (
        id, project_id, episode_id, pipeline_run_id, type, status, progress, resource_type,
        resource_id, provider_id, model, provider_config_revision, external_task_id,
        idempotency_key, retry_of, attempt, input_json, provider_state_json, progress_detail_json,
        output_json, error_json, cost_json, created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.episodeId ?? null,
      input.pipelineRunId ?? null,
      input.type,
      status,
      normalizeProgress(input.progress ?? 0),
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.providerId ?? null,
      providerBinding.model,
      input.providerConfigRevision ?? null,
      input.externalTaskId ?? null,
      input.idempotencyKey ?? null,
      input.retryOf ?? null,
      normalizePositiveInteger(input.attempt ?? 1, 'job attempt'),
      serializeJson(input.input),
      serializeJson(input.providerState ?? {}),
      serializeJson(input.progressDetail ?? {}),
      input.output === undefined || input.output === null ? null : serializeJson(input.output),
      input.error === undefined || input.error === null ? null : serializeJson(input.error),
      cost === undefined || cost === null ? null : serializeJson(cost),
      createdAt,
      updatedAt,
      input.startedAt ?? null,
      input.completedAt ?? null,
    )
    return this.requireGenerationJob(id)
  }

  getGenerationJob(id: string): GenerationJobRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as SqlRow | undefined
    return row ? this.withGenerationJobPlatformCostPolicy(asGenerationJob(row)) : undefined
  }

  findGenerationJobByIdempotencyKey(projectId: string, idempotencyKey: string): GenerationJobRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT * FROM generation_jobs WHERE project_id = ? AND idempotency_key = ?
    `).get(projectId, idempotencyKey) as SqlRow | undefined
    return row ? this.withGenerationJobPlatformCostPolicy(asGenerationJob(row)) : undefined
  }

  listGenerationJobs(options: ListGenerationJobsOptions = {}): GenerationJobRecord[] {
    this.assertOpen()
    const clauses: string[] = []
    const bindings: SQLInputValue[] = []
    if (options.projectId !== undefined) {
      clauses.push('project_id = ?')
      bindings.push(options.projectId)
    }
    if (options.episodeId !== undefined) {
      clauses.push('episode_id = ?')
      bindings.push(options.episodeId)
    }
    if (options.pipelineRunId !== undefined) {
      clauses.push('pipeline_run_id = ?')
      bindings.push(options.pipelineRunId)
    }
    if (options.status !== undefined) {
      clauses.push('status = ?')
      bindings.push(options.status)
    }
    if (options.type !== undefined) {
      clauses.push('type = ?')
      bindings.push(options.type)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    bindings.push(normalizeLimit(options.limit), normalizeOffset(options.offset))
    const rows = this.database.prepare(`
      SELECT * FROM generation_jobs ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...bindings) as SqlRow[]
    return rows.map((row) => this.withGenerationJobPlatformCostPolicy(asGenerationJob(row)))
  }

  updateGenerationJob(id: string, input: UpdateGenerationJobInput): GenerationJobRecord | undefined {
    this.assertOpen()
    const current = this.getGenerationJob(id)
    if (!current) return undefined
    this.assertProjectReference(current.projectId, 'generation_jobs', input.retryOf, 'Retry source job')
    for (const [label, requested, persisted] of [
      ['providerId', input.providerId, current.providerId],
      ['model', input.model, current.model],
      ['providerConfigRevision', input.providerConfigRevision, current.providerConfigRevision],
    ] as const) {
      if (requested !== undefined && requested !== persisted) {
        throw new ProviderVersionIntegrityError(`Generation job ${label} is immutable`)
      }
    }
    const fields: Array<[string, SQLInputValue]> = []
    if (input.status !== undefined) {
      if (!JOB_STATUSES.has(input.status)) throw new TypeError(`Unsupported job status: ${input.status}`)
      fields.push(['status', input.status])
    }
    if (input.progress !== undefined) fields.push(['progress', normalizeProgress(input.progress)])
    if (input.resourceType !== undefined) fields.push(['resource_type', input.resourceType])
    if (input.resourceId !== undefined) fields.push(['resource_id', input.resourceId])
    if (input.providerId !== undefined) fields.push(['provider_id', input.providerId])
    if (input.model !== undefined) fields.push(['model', input.model])
    if (input.providerConfigRevision !== undefined) {
      fields.push(['provider_config_revision', input.providerConfigRevision])
    }
    if (input.externalTaskId !== undefined) fields.push(['external_task_id', input.externalTaskId])
    if (input.idempotencyKey !== undefined) fields.push(['idempotency_key', input.idempotencyKey])
    if (input.retryOf !== undefined) fields.push(['retry_of', input.retryOf])
    if (input.attempt !== undefined) fields.push(['attempt', normalizePositiveInteger(input.attempt, 'job attempt')])
    if (input.input !== undefined) fields.push(['input_json', serializeJson(input.input)])
    if (input.providerState !== undefined) fields.push(['provider_state_json', serializeJson(input.providerState)])
    if (input.progressDetail !== undefined) fields.push(['progress_detail_json', serializeJson(input.progressDetail)])
    if (input.output !== undefined) fields.push(['output_json', input.output === null ? null : serializeJson(input.output)])
    if (input.error !== undefined) fields.push(['error_json', input.error === null ? null : serializeJson(input.error)])
    if (input.cost !== undefined) {
      const providerKind = this.resolveProviderBinding(
        current.providerId,
        current.providerConfigRevision,
        current.model,
      ).kind
      const cost = providerKind === null
        ? input.cost
        : withProviderPlatformCostPolicy(providerKind, input.cost)
      fields.push(['cost_json', cost === null ? null : serializeJson(cost)])
    }
    if (input.startedAt !== undefined) fields.push(['started_at', input.startedAt])
    if (input.completedAt !== undefined) fields.push(['completed_at', input.completedAt])
    fields.push(['updated_at', this.now()])
    this.runUpdate('generation_jobs', id, fields)
    return this.getGenerationJob(id)
  }

  deleteGenerationJob(id: string): boolean {
    this.assertOpen()
    return Number(this.database.prepare('DELETE FROM generation_jobs WHERE id = ?').run(id).changes) > 0
  }

  createProviderConnection(input: CreateProviderConnectionInput): ProviderConnectionRecord {
    this.assertOpen()
    return this.transaction(() => {
      const id = input.id ?? this.idFactory()
      const createdAt = input.createdAt ?? this.now()
      const updatedAt = input.updatedAt ?? createdAt
      const credential = input.credentialReference ?? null
      this.database.prepare(`
        INSERT INTO provider_connections (
          id, kind, adapter, display_name, base_url, default_model, auth_mode, keychain_service,
          keychain_account, config_json, config_revision, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        id,
        input.kind,
        input.adapter,
        input.displayName,
        validateProviderBaseUrl(input.baseUrl ?? null),
        input.defaultModel ?? null,
        input.authMode,
        credential?.service ?? null,
        credential?.account ?? null,
        serializeJson(input.config ?? {}),
        input.enabled === false ? 0 : 1,
        createdAt,
        updatedAt,
      )
      const record = this.requireProviderConnection(id)
      this.insertProviderConnectionVersion(record)
      return record
    })
  }

  getProviderConnection(id: string): ProviderConnectionRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT * FROM provider_connections WHERE id = ?').get(id) as SqlRow | undefined
    return row ? asProviderConnection(row) : undefined
  }

  listProviderConnections(kind?: ProviderKind): ProviderConnectionRecord[] {
    this.assertOpen()
    const rows = kind === undefined
      ? this.database.prepare('SELECT * FROM provider_connections ORDER BY kind, display_name, id').all()
      : this.database.prepare(`
        SELECT * FROM provider_connections WHERE kind = ? ORDER BY display_name, id
      `).all(kind)
    return (rows as SqlRow[]).map(asProviderConnection)
  }

  getProviderConnectionVersion(
    providerId: string,
    configRevision: number,
  ): ProviderConnectionVersionRecord | undefined {
    this.assertOpen()
    const revision = normalizePositiveInteger(configRevision, 'provider config revision')
    const row = this.database.prepare(`
      SELECT * FROM provider_connection_versions
       WHERE provider_id = ? AND config_revision = ?
    `).get(providerId, revision) as SqlRow | undefined
    return row ? asProviderConnectionVersion(row) : undefined
  }

  listProviderConnectionVersions(providerId: string): ProviderConnectionVersionRecord[] {
    this.assertOpen()
    return (this.database.prepare(`
      SELECT * FROM provider_connection_versions
       WHERE provider_id = ?
       ORDER BY config_revision ASC
    `).all(providerId) as SqlRow[]).map(asProviderConnectionVersion)
  }

  updateProviderConnection(id: string, input: UpdateProviderConnectionInput): ProviderConnectionRecord | undefined {
    this.assertOpen()
    return this.transaction(() => {
      const current = this.getProviderConnection(id)
      const fields: Array<[string, SQLInputValue]> = []
      let configurationChanged = false
      if (input.kind !== undefined) {
        fields.push(['kind', input.kind])
        configurationChanged ||= current?.kind !== input.kind
      }
      if (input.adapter !== undefined) {
        fields.push(['adapter', input.adapter])
        configurationChanged ||= current?.adapter !== input.adapter
      }
      if (input.displayName !== undefined) fields.push(['display_name', input.displayName])
      if (input.baseUrl !== undefined) {
        const baseUrl = validateProviderBaseUrl(input.baseUrl)
        fields.push(['base_url', baseUrl])
        configurationChanged ||= current?.baseUrl !== baseUrl
      }
      if (input.defaultModel !== undefined) {
        fields.push(['default_model', input.defaultModel])
        configurationChanged ||= current?.defaultModel !== input.defaultModel
      }
      if (input.authMode !== undefined) {
        fields.push(['auth_mode', input.authMode])
        configurationChanged ||= current?.authMode !== input.authMode
      }
      if (input.credentialReference !== undefined) {
        fields.push(['keychain_service', input.credentialReference?.service ?? null])
        fields.push(['keychain_account', input.credentialReference?.account ?? null])
        configurationChanged ||= !sameCredentialReference(
          current?.credentialReference ?? null,
          input.credentialReference,
        )
      }
      if (input.config !== undefined) {
        fields.push(['config_json', serializeJson(input.config)])
        configurationChanged ||= !current || !isDeepStrictEqual(
          providerGenerationOptions(current.config),
          providerGenerationOptions(input.config),
        )
      }
      if (input.enabled !== undefined) fields.push(['enabled', input.enabled ? 1 : 0])
      if (fields.length === 0) return current
      if (configurationChanged) fields.push(['config_revision', this.providerConfigRevision(id) + 1])
      fields.push(['updated_at', this.now()])
      this.runUpdate('provider_connections', id, fields)
      const updated = this.getProviderConnection(id)
      if (configurationChanged && updated) this.insertProviderConnectionVersion(updated)
      return updated
    })
  }

  deleteProviderConnection(id: string): boolean {
    this.assertOpen()
    return Number(this.database.prepare('DELETE FROM provider_connections WHERE id = ?').run(id).changes) > 0
  }

  listLegacyImports(): LegacyImportRecord[] {
    this.assertOpen()
    const rows = this.database.prepare('SELECT * FROM legacy_imports ORDER BY imported_at, source_path').all() as SqlRow[]
    return rows.map((row) => ({
      sourcePath: requiredString(row, 'source_path'),
      sourceChecksum: requiredString(row, 'source_checksum'),
      sourceVersion: requiredNumber(row, 'source_version'),
      projectId: requiredString(row, 'project_id'),
      counts: parseJsonObject(row.counts_json, 'counts_json') as unknown as LegacyImportCounts,
      importedAt: requiredString(row, 'imported_at'),
    }))
  }

  importLegacyState(sourcePath: string): LegacyImportResult {
    this.assertOpen()
    const absolutePath = resolve(sourcePath)
    if (!existsSync(absolutePath)) return { status: 'not-found', sourcePath: absolutePath }

    const previous = this.database.prepare(`
      SELECT project_id FROM legacy_imports WHERE source_path = ?
    `).get(absolutePath) as SqlRow | undefined
    if (previous) {
      return {
        status: 'already-imported',
        sourcePath: absolutePath,
        projectId: requiredString(previous, 'project_id'),
      }
    }

    // Deliberately read-only: the legacy file is never renamed, truncated, chmodded, or deleted.
    const sourceBytes = readFileSync(absolutePath)
    const checksum = createHash('sha256').update(sourceBytes).digest('hex')
    const parsed: unknown = JSON.parse(sourceBytes.toString('utf8'))
    const legacy = asLegacyState(parsed)

    return this.transaction(() => {
      const concurrent = this.database.prepare(`
        SELECT project_id FROM legacy_imports WHERE source_path = ?
      `).get(absolutePath) as SqlRow | undefined
      if (concurrent) {
        return {
          status: 'already-imported' as const,
          sourcePath: absolutePath,
          projectId: requiredString(concurrent, 'project_id'),
        }
      }

      const project = legacy.project as Record<string, unknown>
      const now = this.now()
      const updatedAt = normalizeTimestamp(project.updatedAt, now)
      const createdAt = normalizeTimestamp(project.createdAt, updatedAt)
      const metadataProjectId = legacy.jobs
        .map((job) => isPlainObject(job) && isPlainObject(job.input) && isPlainObject(job.input.metadata)
          ? safeIdentifier(job.input.metadata.projectId)
          : null)
        .find((id): id is string => id !== null)
      const preferredId = safeIdentifier(project.id) ?? metadataProjectId ?? `legacy-${checksum.slice(0, 16)}`
      const projectId = this.uniqueId('projects', preferredId, checksum)
      const episodeId = this.uniqueId('episodes', `${projectId}:episode:1`, checksum)
      const revisionId = this.uniqueId('revisions', `${projectId}:revision:import`, checksum)
      const settingsValue = isPlainObject(project.settings) ? sanitizeLegacyJson(project.settings) : {}
      const settings = isPlainObject(settingsValue) ? settingsValue as JsonObject : {}
      const title = typeof project.title === 'string' && project.title.trim() ? project.title.trim() : '导入项目'

      this.createProject({ id: projectId, title, settings, createdAt, updatedAt })

      const shots = Array.isArray(project.shots) ? project.shots : []
      const targetDuration = shots.reduce((total, shot) => {
        return total + (isPlainObject(shot) ? parseLegacyDuration(shot.duration) : 0)
      }, 0)
      const aspect = typeof settings.aspect === 'string' ? settings.aspect : '16:9'
      const style = typeof settings.style === 'string'
        ? settings.style
        : typeof settings.imageStyle === 'string' ? settings.imageStyle : ''
      this.database.prepare(`
        INSERT INTO episodes (
          id, project_id, title, source_text, target_duration_seconds, aspect_ratio,
          style_preset, status, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?)
      `).run(
        episodeId,
        projectId,
        '第 1 集',
        typeof project.sourceText === 'string' ? project.sourceText : '',
        targetDuration || null,
        aspect,
        style,
        createdAt,
        updatedAt,
      )

      const snapshotValue = sanitizeLegacyJson(legacy.project)
      const snapshot = isPlainObject(snapshotValue) ? snapshotValue as JsonObject : {}
      this.createRevision({
        id: revisionId,
        projectId,
        summary: '从旧 state.json 导入',
        snapshot,
        createdAt: updatedAt,
      })

      const jobIds = new Map<number, string>()
      const legacyJobIdMap = new Map<string, string>()
      legacy.jobs.forEach((value, index) => {
        const original = isPlainObject(value) ? safeIdentifier(value.id) : null
        const id = this.uniqueId('generation_jobs', original ?? `${projectId}:job:${index + 1}`, `${checksum}:${index}`)
        jobIds.set(index, id)
        if (original) legacyJobIdMap.set(original, id)
      })

      const assetByUrl = new Map<string, string>()
      let importedJobs = 0
      let importedAssets = 0
      legacy.jobs.forEach((value, index) => {
        if (!isPlainObject(value)) return
        const id = jobIds.get(index) as string
        const statusValue = typeof value.status === 'string' && JOB_STATUSES.has(value.status as JobStatus)
          ? value.status as JobStatus
          : 'failed'
        const inputValue = sanitizeLegacyJson(isPlainObject(value.input) ? value.input : {})
        const outputValue = sanitizeLegacyJson(isPlainObject(value.output) ? value.output : {})
        const errorValue = sanitizeLegacyJson(isPlainObject(value.error) ? value.error : {})
        const retryOf = typeof value.retryOf === 'string' ? legacyJobIdMap.get(value.retryOf) ?? null : null
        const jobCreatedAt = normalizeTimestamp(value.createdAt, createdAt)
        const jobUpdatedAt = normalizeTimestamp(value.updatedAt, jobCreatedAt)
        this.createGenerationJob({
          id,
          projectId,
          episodeId,
          type: typeof value.type === 'string' && value.type ? value.type : 'asset.image.generate',
          status: statusValue,
          progress: typeof value.progress === 'number' ? Math.min(Math.max(value.progress, 0), 100) : 0,
          retryOf,
          attempt: typeof value.attempt === 'number' && Number.isInteger(value.attempt) && value.attempt > 0
            ? value.attempt
            : 1,
          input: isPlainObject(inputValue) ? inputValue as JsonObject : {},
          output: isPlainObject(value.output) && isPlainObject(outputValue) ? outputValue as JsonObject : null,
          error: isPlainObject(value.error) && isPlainObject(errorValue) ? errorValue as JsonObject : null,
          createdAt: jobCreatedAt,
          updatedAt: jobUpdatedAt,
          startedAt: typeof value.startedAt === 'string' ? normalizeTimestamp(value.startedAt, jobUpdatedAt) : null,
          completedAt: typeof value.completedAt === 'string' ? normalizeTimestamp(value.completedAt, jobUpdatedAt) : null,
        })
        importedJobs += 1

        const images = isPlainObject(value.output) && Array.isArray(value.output.images) ? value.output.images : []
        images.forEach((image, imageIndex) => {
          if (!isPlainObject(image)) return
          const originalAssetId = safeIdentifier(image.id)
          const assetId = this.uniqueId(
            'media_assets',
            originalAssetId ?? `${projectId}:asset:${index + 1}:${imageIndex + 1}`,
            `${checksum}:${index}:${imageIndex}`,
          )
          const url = typeof image.url === 'string' ? image.url : null
          const generationValue = sanitizeLegacyJson(isPlainObject(value.input) ? value.input : {})
          const legacyKind = isPlainObject(value.input) && isPlainObject(value.input.metadata)
            && typeof value.input.metadata.kind === 'string' && value.input.metadata.kind.trim()
            ? value.input.metadata.kind.trim()
            : 'image'
          this.createMediaAsset({
            id: assetId,
            projectId,
            episodeId,
            kind: legacyKind,
            status: statusValue === 'succeeded' ? 'ready' : 'unverified',
            filePath: legacyLocalFilePath(url),
            mimeType: typeof image.mimeType === 'string' ? image.mimeType : null,
            width: typeof image.width === 'number' && image.width > 0 ? Math.floor(image.width) : null,
            height: typeof image.height === 'number' && image.height > 0 ? Math.floor(image.height) : null,
            source: 'legacy-import',
            generationJobId: id,
            generationParameters: isPlainObject(generationValue) ? generationValue as JsonObject : {},
            sourceRevisionId: revisionId,
            createdAt: jobUpdatedAt,
            updatedAt: jobUpdatedAt,
          })
          if (url) assetByUrl.set(url, assetId)
          importedAssets += 1
        })
      })

      let importedScenes = 0
      let importedShots = 0
      let importedDialogueLines = 0
      if (shots.length > 0) {
        const sceneId = this.uniqueId('scenes', `${projectId}:scene:1`, checksum)
        this.database.prepare(`
          INSERT INTO scenes (
            id, episode_id, sequence, title, description, duration_seconds,
            metadata_json, created_at, updated_at
          ) VALUES (?, ?, 0, ?, '', ?, '{}', ?, ?)
        `).run(sceneId, episodeId, '导入分镜', targetDuration || null, createdAt, updatedAt)
        importedScenes = 1

        shots.forEach((value, index) => {
          if (!isPlainObject(value)) return
          const legacyShotId = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id) : String(index + 1)
          const shotId = this.uniqueId('shots', `${projectId}:shot:${legacyShotId}`, `${checksum}:${index}`)
          const imageUrl = typeof value.imageUrl === 'string' ? value.imageUrl : null
          let storyboardAssetId = imageUrl ? assetByUrl.get(imageUrl) ?? null : null
          if (imageUrl && !storyboardAssetId) {
            storyboardAssetId = this.uniqueId('media_assets', `${projectId}:shot-asset:${legacyShotId}`, `${checksum}:shot:${index}`)
            this.createMediaAsset({
              id: storyboardAssetId,
              projectId,
              episodeId,
              kind: 'storyboard',
              status: 'ready',
              filePath: legacyLocalFilePath(imageUrl),
              source: 'legacy-import',
              generationJobId: typeof value.jobId === 'string' ? legacyJobIdMap.get(value.jobId) ?? null : null,
              sourceRevisionId: revisionId,
              createdAt: updatedAt,
              updatedAt,
            })
            assetByUrl.set(imageUrl, storyboardAssetId)
            importedAssets += 1
          }

          const metadataValue = sanitizeLegacyJson(value)
          const metadata = isPlainObject(metadataValue) ? { ...metadataValue } as JsonObject : {}
          delete metadata.imageUrl
          delete metadata.dialogue
          this.database.prepare(`
            INSERT INTO shots (
              id, scene_id, sequence, code, title, description, framing, movement, transition,
              duration_seconds, prompt, status, storyboard_asset_id, source_revision_id,
              metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', ?, ?, ?, ?, ?, ?)
          `).run(
            shotId,
            sceneId,
            index,
            typeof value.code === 'string' ? value.code : '',
            typeof value.title === 'string' ? value.title : '',
            typeof value.copy === 'string' ? value.copy : '',
            typeof value.framing === 'string' ? value.framing : '',
            typeof value.movement === 'string' ? value.movement : '',
            parseLegacyDuration(value.duration),
            typeof value.status === 'string' ? value.status : 'draft',
            storyboardAssetId,
            revisionId,
            serializeJson(metadata),
            createdAt,
            updatedAt,
          )
          importedShots += 1

          if (typeof value.dialogue === 'string' && value.dialogue.trim()) {
            const separator = value.dialogue.search(/[:：]/)
            const speaker = separator >= 0 ? value.dialogue.slice(0, separator).trim() : ''
            const text = separator >= 0 ? value.dialogue.slice(separator + 1).trim() : value.dialogue.trim()
            const dialogueMetadata: JsonObject = speaker ? { speaker } : {}
            this.database.prepare(`
              INSERT INTO dialogue_lines (
                id, shot_id, sequence, kind, text, metadata_json, created_at, updated_at
              ) VALUES (?, ?, 0, ?, ?, ?, ?, ?)
            `).run(
              this.uniqueId('dialogue_lines', `${shotId}:dialogue:1`, `${checksum}:${index}:dialogue`),
              shotId,
              speaker === '旁白' ? 'narration' : 'dialogue',
              text,
              serializeJson(dialogueMetadata),
              createdAt,
              updatedAt,
            )
            importedDialogueLines += 1
          }
        })
      }

      // Preserve the legacy project timestamp; setting relationship pointers is part of
      // the import itself, not a user edit that should make the project look newly changed.
      this.database.prepare(`
        UPDATE projects
        SET current_episode_id = ?, current_revision_id = ?, updated_at = ?
        WHERE id = ?
      `).run(episodeId, revisionId, updatedAt, projectId)
      const counts: LegacyImportCounts = {
        projects: 1,
        episodes: 1,
        revisions: 1,
        scenes: importedScenes,
        shots: importedShots,
        dialogueLines: importedDialogueLines,
        jobs: importedJobs,
        assets: importedAssets,
      }
      this.database.prepare(`
        INSERT INTO legacy_imports (
          source_path, source_checksum, source_version, project_id, counts_json, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(absolutePath, checksum, legacy.version, projectId, serializeJson(counts as unknown as JsonObject), this.now())

      return { status: 'imported' as const, sourcePath: absolutePath, projectId, checksum, counts }
    })
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Database is closed')
  }

  private runUpdate(table: string, id: string, fields: Array<[string, SQLInputValue]>): boolean {
    if (fields.length === 0) return false
    const assignments = fields.map(([column]) => `${column} = ?`).join(', ')
    const bindings = fields.map(([, value]) => value)
    return Number(this.database.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(...bindings, id).changes) > 0
  }

  private uniqueId(table: string, preferred: string, salt: string): string {
    let candidate = preferred
    let sequence = 0
    while (this.database.prepare(`SELECT 1 AS present FROM ${table} WHERE id = ?`).get(candidate)) {
      sequence += 1
      const suffix = createHash('sha256').update(`${salt}:${sequence}`).digest('hex').slice(0, 10)
      candidate = `${preferred}-legacy-${suffix}`
    }
    return candidate
  }

  private resolveProviderBinding(
    providerId: string | null,
    configRevision: number | null,
    requestedModel: string | null,
  ): { kind: ProviderKind | null; model: string | null } {
    if (providerId === null && configRevision === null) {
      return { kind: null, model: requestedModel }
    }
    if (providerId === null || configRevision === null) {
      throw new ProviderVersionIntegrityError(
        'Generation jobs must bind providerId and providerConfigRevision together',
      )
    }
    const version = this.getProviderConnectionVersion(providerId, configRevision)
    if (!version) {
      throw new ProviderVersionIntegrityError(
        `Provider execution profile does not exist: ${providerId}@${configRevision}`,
      )
    }
    // Keep the legacy job.model display field when supplied. Execution must
    // use the immutable version.model returned by getProviderConnectionVersion;
    // app-v1 wiring migrates to that materialized profile separately.
    return { kind: version.kind, model: requestedModel ?? version.model }
  }

  /**
   * Old databases may contain Provider-backed jobs created before the explicit
   * platform-cost policy existed. Derive the same namespaced projection from
   * the immutable Provider revision on every read; new writes also persist it.
   */
  private withGenerationJobPlatformCostPolicy(
    record: GenerationJobRecord,
  ): GenerationJobRecord {
    if (record.providerId === null || record.providerConfigRevision === null) return record
    const version = this.getProviderConnectionVersion(
      record.providerId,
      record.providerConfigRevision,
    )
    if (!version) return record
    return {
      ...record,
      cost: withProviderPlatformCostPolicy(version.kind, record.cost),
    }
  }

  /**
   * SQLite's scalar foreign keys prove that a referenced row exists, but they
   * do not prove that both rows belong to the same project. Keep that invariant
   * at every typed write boundary. Missing rows are intentionally left to the
   * existing FK so deferred workflows and native constraint errors retain
   * their current semantics.
   */
  private assertProjectReference(
    projectId: string,
    table: 'episodes' | 'generation_jobs' | 'media_assets' | 'pipeline_runs' | 'revisions',
    referenceId: string | null | undefined,
    referenceType: string,
  ): void {
    if (referenceId === null || referenceId === undefined) return
    const row = this.database.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(referenceId) as
      | SqlRow
      | undefined
    if (row && requiredString(row, 'project_id') !== projectId) {
      throw new DatabaseIntegrityError(projectId, referenceType, referenceId)
    }
  }

  private insertProviderConnectionVersion(record: ProviderConnectionRecord): void {
    this.database.prepare(`
      INSERT INTO provider_connection_versions (
        provider_id, config_revision, kind, adapter, base_url, model, auth_mode,
        keychain_service, keychain_account, execution_config_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.configRevision,
      record.kind,
      record.adapter,
      record.baseUrl,
      record.defaultModel,
      record.authMode,
      record.credentialReference?.service ?? null,
      record.credentialReference?.account ?? null,
      serializeJson(providerGenerationOptions(record.config)),
      record.updatedAt,
    )
  }

  private requireProject(id: string): ProjectRecord {
    const value = this.getProject(id)
    if (!value) throw new Error(`Project was not found after write: ${id}`)
    return value
  }

  private requireRevision(id: string): RevisionRecord {
    const value = this.getRevision(id)
    if (!value) throw new Error(`Revision was not found after write: ${id}`)
    return value
  }

  private requireMediaAsset(id: string): MediaAssetRecord {
    const value = this.getMediaAsset(id)
    if (!value) throw new Error(`Media asset was not found after write: ${id}`)
    return value
  }

  private requireGenerationJob(id: string): GenerationJobRecord {
    const value = this.getGenerationJob(id)
    if (!value) throw new Error(`Generation job was not found after write: ${id}`)
    return value
  }

  private requirePipelineRun(id: string): PipelineRunRecord {
    const value = this.getPipelineRun(id)
    if (!value) throw new Error(`Pipeline run was not found after write: ${id}`)
    return value
  }

  private requireProviderConnection(id: string): ProviderConnectionRecord {
    const value = this.getProviderConnection(id)
    if (!value) throw new Error(`Provider connection was not found after write: ${id}`)
    return value
  }

  private providerConfigRevision(id: string): number {
    const row = this.database.prepare(`
      SELECT config_revision FROM provider_connections WHERE id = ?
    `).get(id) as SqlRow | undefined
    return row ? requiredNumber(row, 'config_revision') : 0
  }
}

export function initializeDatabase(options: DatabaseOptions = {}): ManjuDatabase {
  const runtimeDirectory = resolve(options.runtimeDirectory ?? 'runtime')
  const databasePath = options.databasePath === ':memory:'
    ? ':memory:'
    : resolve(options.databasePath ?? runtimeDirectory, options.databasePath ? '' : 'manju.sqlite')
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })

  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError('busyTimeoutMs must be a non-negative integer')
  }

  const sqlite = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: busyTimeoutMs,
  })

  try {
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    sqlite.exec('PRAGMA journal_mode = WAL')
    sqlite.exec('PRAGMA synchronous = NORMAL')
    const currentVersion = schemaVersion(sqlite)
    verifiedPreMigrationBackup(
      sqlite,
      databasePath,
      currentVersion,
      DATABASE_SCHEMA_VERSION,
      options.backupDirectory,
    )
    migrate(sqlite)

    const database = new ManjuDatabase(sqlite, databasePath, options.now ?? (() => new Date().toISOString()), options.idFactory ?? randomUUID)
    const legacyStatePath = options.legacyStatePath === false
      ? null
      : resolve(options.legacyStatePath ?? (databasePath === ':memory:' ? runtimeDirectory : dirname(databasePath)), options.legacyStatePath ? '' : 'state.json')
    if (legacyStatePath) database.importLegacyState(legacyStatePath)
    return database
  } catch (error) {
    sqlite.close()
    throw error
  }
}

export const openDatabase = initializeDatabase
