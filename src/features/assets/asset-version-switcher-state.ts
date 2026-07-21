import type { MediaAsset } from '../../lib/api-types'

/**
 * One immutable version that belongs to a stable project-level Asset handle.
 *
 * `assetId` is the logical material identity shown in the library. The
 * existing `MediaAsset.id` is the immutable version identity and therefore
 * must exactly equal `assetVersionId`.
 */
export interface ProjectAssetVersion {
  assetId: string
  assetVersionId: string
  /** Authoritative ordinal inside the stable Asset handle. */
  versionNumber: number
  asset: MediaAsset
}

/** A production slot always pins an exact immutable version, never a default. */
export interface ProductionAssetVersionPin {
  slotId: string
  assetId: string
  assetVersionId: string
  checksum: string
}

export interface AssetVersionOption {
  assetId: string
  assetVersionId: string
  asset: MediaAsset
  isDefault: boolean
  isSelected: boolean
  switchable: boolean
  pinnedSlots: string[]
}

export type AssetVersionSwitcherIssueCode =
  | 'DUPLICATE_VERSION_ID'
  | 'DUPLICATE_VERSION_NUMBER'
  | 'INVALID_VERSION_IDENTITY'
  | 'DEFAULT_VERSION_MISSING'
  | 'SELECTED_VERSION_MISSING'
  | 'INVALID_PRODUCTION_PIN'

export interface AssetVersionSwitcherIssue {
  code: AssetVersionSwitcherIssueCode
  message: string
  assetVersionId?: string
  slotId?: string
}

export interface AssetVersionSwitcherState {
  assetId: string
  /** Persisted project-library default. It is not a production reference. */
  defaultAssetVersionId: string | null
  /** Ephemeral version inspected by the user in the version strip. */
  selectedAssetVersionId: string | null
  versions: AssetVersionOption[]
  productionPins: ProductionAssetVersionPin[]
  issues: AssetVersionSwitcherIssue[]
}

function validChecksum(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function versionIsSwitchable(version: ProjectAssetVersion): boolean {
  return version.asset.status === 'ready'
    && version.asset.id === version.assetVersionId
    && Number.isSafeInteger(version.versionNumber)
    && version.versionNumber >= 1
    && validChecksum(version.asset.checksum)
}

/**
 * Builds the UI state for a thumbnail version strip.
 *
 * The helper deliberately does not infer a stable `assetId` from
 * `parentAssetId`: incomplete ancestry and cross-revision adoption make that
 * inference unsafe. The server must return the stable handle explicitly.
 */
export function buildAssetVersionSwitcherState(input: {
  assetId: string
  versions: readonly ProjectAssetVersion[]
  defaultAssetVersionId: string | null
  selectedAssetVersionId?: string | null
  productionPins?: readonly ProductionAssetVersionPin[]
}): AssetVersionSwitcherState {
  const issues: AssetVersionSwitcherIssue[] = []
  const seenIds = new Set<string>()
  const seenVersionNumbers = new Set<number>()
  const validVersions: ProjectAssetVersion[] = []

  for (const version of input.versions) {
    if (version.assetId !== input.assetId || version.asset.id !== version.assetVersionId) {
      issues.push({
        code: 'INVALID_VERSION_IDENTITY',
        assetVersionId: version.assetVersionId,
        message: `版本 ${version.assetVersionId} 不属于素材 ${input.assetId}`,
      })
      continue
    }
    if (seenIds.has(version.assetVersionId)) {
      issues.push({
        code: 'DUPLICATE_VERSION_ID',
        assetVersionId: version.assetVersionId,
        message: `素材版本 ID ${version.assetVersionId} 重复`,
      })
      continue
    }
    seenIds.add(version.assetVersionId)
    if (!Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1) {
      issues.push({
        code: 'INVALID_VERSION_IDENTITY',
        assetVersionId: version.assetVersionId,
        message: `素材版本 ${version.assetVersionId} 缺少有效的族内序号`,
      })
      continue
    }
    if (seenVersionNumbers.has(version.versionNumber)) {
      issues.push({
        code: 'DUPLICATE_VERSION_NUMBER',
        assetVersionId: version.assetVersionId,
        message: `素材 ${input.assetId} 的 v${version.versionNumber} 重复`,
      })
      continue
    }
    seenVersionNumbers.add(version.versionNumber)
    validVersions.push(version)
  }

  const versionsById = new Map(validVersions.map((version) => [version.assetVersionId, version]))
  const defaultAssetVersionId = input.defaultAssetVersionId
  if (defaultAssetVersionId && !versionsById.has(defaultAssetVersionId)) {
    issues.push({
      code: 'DEFAULT_VERSION_MISSING',
      assetVersionId: defaultAssetVersionId,
      message: `默认版本 ${defaultAssetVersionId} 不在素材 ${input.assetId} 的版本列表中`,
    })
  }

  const requestedSelection = input.selectedAssetVersionId === undefined
    ? defaultAssetVersionId
    : input.selectedAssetVersionId
  const selectedAssetVersionId = requestedSelection && versionsById.has(requestedSelection)
    ? requestedSelection
    : null
  if (requestedSelection && !selectedAssetVersionId) {
    issues.push({
      code: 'SELECTED_VERSION_MISSING',
      assetVersionId: requestedSelection,
      message: `所选版本 ${requestedSelection} 不在素材 ${input.assetId} 的版本列表中`,
    })
  }

  const productionPins: ProductionAssetVersionPin[] = []
  for (const pin of input.productionPins ?? []) {
    const version = versionsById.get(pin.assetVersionId)
    if (pin.assetId !== input.assetId
      || !version
      || !validChecksum(pin.checksum)
      || version.asset.checksum?.toLowerCase() !== pin.checksum.toLowerCase()) {
      issues.push({
        code: 'INVALID_PRODUCTION_PIN',
        assetVersionId: pin.assetVersionId,
        slotId: pin.slotId,
        message: `制作槽位 ${pin.slotId} 未固定到素材 ${input.assetId} 的可验证版本`,
      })
      continue
    }
    productionPins.push({ ...pin, checksum: pin.checksum.toLowerCase() })
  }

  const slotsByVersion = new Map<string, string[]>()
  for (const pin of productionPins) {
    const slots = slotsByVersion.get(pin.assetVersionId) ?? []
    slots.push(pin.slotId)
    slotsByVersion.set(pin.assetVersionId, slots)
  }

  const versions = [...validVersions]
    .sort((left, right) => right.versionNumber - left.versionNumber
      || right.asset.createdAt.localeCompare(left.asset.createdAt)
      || right.assetVersionId.localeCompare(left.assetVersionId))
    .map((version): AssetVersionOption => ({
      ...version,
      isDefault: version.assetVersionId === defaultAssetVersionId,
      isSelected: version.assetVersionId === selectedAssetVersionId,
      switchable: versionIsSwitchable(version),
      pinnedSlots: [...(slotsByVersion.get(version.assetVersionId) ?? [])].sort(),
    }))

  return {
    assetId: input.assetId,
    defaultAssetVersionId: defaultAssetVersionId && versionsById.has(defaultAssetVersionId)
      ? defaultAssetVersionId
      : null,
    selectedAssetVersionId,
    versions,
    productionPins,
    issues,
  }
}

/** Preview selection is local-only and must never rewrite defaults or pins. */
export function selectAssetVersion(
  state: AssetVersionSwitcherState,
  assetVersionId: string,
): AssetVersionSwitcherState {
  const selected = state.versions.find((version) => (
    version.assetVersionId === assetVersionId && version.switchable
  ))
  if (!selected) return state
  return {
    ...state,
    selectedAssetVersionId: assetVersionId,
    versions: state.versions.map((version) => ({
      ...version,
      isSelected: version.assetVersionId === assetVersionId,
    })),
  }
}

/**
 * Creates the exact payload for changing the project-library default.
 * Production pins are intentionally absent: upgrading a production manifest
 * is a separate, explicit operation.
 */
export function createAssetDefaultVersionSwitch(input: {
  state: AssetVersionSwitcherState
  assetVersionId: string
  assetHandleEtag: string
}): {
  assetId: string
  assetVersionId: string
  ifMatch: string
} | null {
  const version = input.state.versions.find((candidate) => (
    candidate.assetVersionId === input.assetVersionId && candidate.switchable
  ))
  if (!version || !input.assetHandleEtag.trim()) return null
  return {
    assetId: input.state.assetId,
    assetVersionId: version.assetVersionId,
    ifMatch: input.assetHandleEtag,
  }
}

/** Pins the selected exact immutable version into one production manifest slot. */
export function createProductionAssetVersionPin(input: {
  state: AssetVersionSwitcherState
  slotId: string
  assetVersionId: string
}): ProductionAssetVersionPin | null {
  const version = input.state.versions.find((candidate) => (
    candidate.assetVersionId === input.assetVersionId && candidate.switchable
  ))
  if (!version || !validChecksum(version.asset.checksum) || !input.slotId.trim()) return null
  return {
    slotId: input.slotId,
    assetId: input.state.assetId,
    assetVersionId: version.assetVersionId,
    checksum: version.asset.checksum.toLowerCase(),
  }
}
