import type {
  GenerationJob,
  MediaAsset,
  VisualAssetTargetType,
} from '../../lib/api-types'

type JsonRecord = Record<string, unknown>

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface VisualAssetJobBinding {
  entityType: VisualAssetTargetType
  entityId: string
  expectedRevisionId: string
}

export type VisualAssetOperation = 'generate' | 'edit' | 'variation' | 'history-adopt'

export interface VisualAssetJobProvenance {
  operation: VisualAssetOperation
  sourceAssetId: string | null
  referenceAssetIds: string[]
}

export function visualAssetJobBinding(job: GenerationJob): VisualAssetJobBinding | null {
  if (![
    'asset.image.generate',
    'asset.image.edit',
    'asset.image.turnaround.derive',
    'asset.image.history.adopt',
  ].includes(job.type)
    || !record(job.input)) return null
  const binding = record(job.input.assetEntityBinding) ? job.input.assetEntityBinding : null
  if (!binding
    || !['character', 'location', 'prop'].includes(String(binding.entityType))
    || typeof binding.entityId !== 'string'
    || typeof binding.expectedRevisionId !== 'string') return null
  return {
    entityType: binding.entityType as VisualAssetTargetType,
    entityId: binding.entityId,
    expectedRevisionId: binding.expectedRevisionId,
  }
}

/**
 * Reads only durable provider input. parentAssetId is deliberately absent:
 * legacy text-only regeneration assigned a parent without sending its bytes to
 * the Provider, so ancestry alone is not evidence of a real image edit.
 */
export function visualAssetJobProvenance(job: GenerationJob): VisualAssetJobProvenance | null {
  if (!record(job.input)) return null
  if (job.type === 'asset.image.generate') {
    const referenceAssetIds = Array.isArray(job.input.referenceAssetIds)
      ? job.input.referenceAssetIds.filter((value): value is string => typeof value === 'string')
      : []
    return { operation: 'generate', sourceAssetId: null, referenceAssetIds }
  }
  if (job.type === 'asset.image.history.adopt'
    && job.input.operation === 'asset.image.history.adopt'
    && record(job.input.sourceAsset)
    && typeof job.input.sourceAsset.id === 'string') {
    return {
      operation: 'history-adopt',
      sourceAssetId: job.input.sourceAsset.id,
      referenceAssetIds: [],
    }
  }
  if (job.type !== 'asset.image.edit'
    || job.input.operation !== 'asset.image.edit'
    || typeof job.input.sourceAssetId !== 'string'
    || !record(job.input.editBinding)
    || !record(job.input.editBinding.source)
    || job.input.editBinding.source.assetId !== job.input.sourceAssetId
    || (job.input.editBinding.mode !== 'edit' && job.input.editBinding.mode !== 'variation')
    || !Array.isArray(job.input.editBinding.references)) return null
  const references = job.input.editBinding.references
    .map((value) => record(value) && typeof value.assetId === 'string' ? value.assetId : null)
  if (references.some((value) => value === null)) return null
  return {
    operation: job.input.editBinding.mode,
    sourceAssetId: job.input.sourceAssetId,
    referenceAssetIds: references as string[],
  }
}

export function visualAssetCandidateProvenance(
  asset: MediaAsset,
  job: GenerationJob | undefined,
): VisualAssetJobProvenance {
  const durable = job ? visualAssetJobProvenance(job) : null
  if (durable) return durable
  // Unknown or legacy jobs remain honest: parentAssetId is an ancestry link,
  // not proof that Provider bytes were supplied.
  return { operation: 'generate', sourceAssetId: null, referenceAssetIds: [] }
}
