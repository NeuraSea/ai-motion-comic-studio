export const TURNAROUND_ROLES = ['front', 'side', 'back'] as const

export type TurnaroundRole = (typeof TURNAROUND_ROLES)[number]

export const TURNAROUND_ROLE_LABELS: Readonly<Record<TurnaroundRole, string>> = {
  front: '正面',
  side: '侧面',
  back: '背面',
}

export interface NormalizedCrop {
  x: number
  y: number
  width: number
  height: number
}

export type TurnaroundCrops = Record<TurnaroundRole, NormalizedCrop>

export type TurnaroundCropOrigin = 'geometric-suggestion' | 'manual'

export interface TurnaroundSplitState {
  crops: TurnaroundCrops
  origin: TurnaroundCropOrigin
}

export type TurnaroundCropField = keyof NormalizedCrop

export const MIN_TURNAROUND_CROP_EDGE = 0.08
export const MAX_TURNAROUND_OVERLAP_RATIO = 0.2

export type TurnaroundCropIssueCode =
  | 'missing-crop'
  | 'non-finite-value'
  | 'out-of-bounds'
  | 'crop-too-small'
  | 'excessive-overlap'

export interface TurnaroundCropIssue {
  code: TurnaroundCropIssueCode
  roles: TurnaroundRole[]
  field?: TurnaroundCropField
  message: string
}

export interface TurnaroundCropValidation {
  valid: boolean
  issues: TurnaroundCropIssue[]
}

const NORMALIZED_EPSILON = 1e-6

function cloneCrop(crop: NormalizedCrop): NormalizedCrop {
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
}

export function cloneTurnaroundCrops(crops: TurnaroundCrops): TurnaroundCrops {
  return {
    front: cloneCrop(crops.front),
    side: cloneCrop(crops.side),
    back: cloneCrop(crops.back),
  }
}

/**
 * Equal thirds are only a deterministic geometric starting point. They do not
 * claim that the source image really contains front / side / back views in
 * that order; the dialog must keep this provenance visible until a human
 * confirms the labels and crop bounds.
 */
export function createGeometricTurnaroundSuggestion(): TurnaroundSplitState {
  return {
    origin: 'geometric-suggestion',
    crops: {
      front: { x: 0, y: 0, width: 1 / 3, height: 1 },
      side: { x: 1 / 3, y: 0, width: 1 / 3, height: 1 },
      back: { x: 2 / 3, y: 0, width: 1 / 3, height: 1 },
    },
  }
}

export function createManualTurnaroundSplit(crops: TurnaroundCrops): TurnaroundSplitState {
  return { origin: 'manual', crops: cloneTurnaroundCrops(crops) }
}

/** Updating any field removes the geometric-suggestion claim without clamping invalid input. */
export function updateTurnaroundCrop(
  state: TurnaroundSplitState,
  role: TurnaroundRole,
  patch: Partial<NormalizedCrop>,
): TurnaroundSplitState {
  return {
    origin: 'manual',
    crops: {
      ...state.crops,
      [role]: { ...state.crops[role], ...patch },
    },
  }
}

function cropIsInsideNormalizedBounds(crop: NormalizedCrop): boolean {
  return crop.x >= -NORMALIZED_EPSILON
    && crop.y >= -NORMALIZED_EPSILON
    && crop.width >= 0
    && crop.height >= 0
    && crop.x + crop.width <= 1 + NORMALIZED_EPSILON
    && crop.y + crop.height <= 1 + NORMALIZED_EPSILON
}

export function turnaroundCropOverlapRatio(a: NormalizedCrop, b: NormalizedCrop): number {
  const intersectionWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const intersectionHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const intersectionArea = intersectionWidth * intersectionHeight
  const smallerArea = Math.min(a.width * a.height, b.width * b.height)
  return smallerArea > 0 ? intersectionArea / smallerArea : 0
}

/**
 * Runtime validation intentionally accepts partial input so API/client drift
 * cannot turn a missing view into an apparently valid three-view selection.
 */
export function validateTurnaroundCrops(
  crops: Partial<Record<TurnaroundRole, NormalizedCrop>> | null | undefined,
): TurnaroundCropValidation {
  const issues: TurnaroundCropIssue[] = []
  const structurallyValid = new Set<TurnaroundRole>()

  for (const role of TURNAROUND_ROLES) {
    const crop = crops?.[role]
    if (!crop) {
      issues.push({
        code: 'missing-crop',
        roles: [role],
        message: `缺少${TURNAROUND_ROLE_LABELS[role]}裁切框`,
      })
      continue
    }

    const fields: TurnaroundCropField[] = ['x', 'y', 'width', 'height']
    const invalidField = fields.find((field) => !Number.isFinite(crop[field]))
    if (invalidField) {
      issues.push({
        code: 'non-finite-value',
        roles: [role],
        field: invalidField,
        message: `${TURNAROUND_ROLE_LABELS[role]}裁切框包含无效数值`,
      })
      continue
    }

    if (!cropIsInsideNormalizedBounds(crop)) {
      issues.push({
        code: 'out-of-bounds',
        roles: [role],
        message: `${TURNAROUND_ROLE_LABELS[role]}裁切框必须完整位于原图边界内`,
      })
    }
    if (
      crop.width + NORMALIZED_EPSILON < MIN_TURNAROUND_CROP_EDGE
      || crop.height + NORMALIZED_EPSILON < MIN_TURNAROUND_CROP_EDGE
    ) {
      issues.push({
        code: 'crop-too-small',
        roles: [role],
        message: `${TURNAROUND_ROLE_LABELS[role]}裁切框宽高均不能小于 ${Math.round(MIN_TURNAROUND_CROP_EDGE * 100)}%`,
      })
    }

    if (cropIsInsideNormalizedBounds(crop)
      && crop.width + NORMALIZED_EPSILON >= MIN_TURNAROUND_CROP_EDGE
      && crop.height + NORMALIZED_EPSILON >= MIN_TURNAROUND_CROP_EDGE) {
      structurallyValid.add(role)
    }
  }

  for (let firstIndex = 0; firstIndex < TURNAROUND_ROLES.length; firstIndex += 1) {
    const firstRole = TURNAROUND_ROLES[firstIndex]
    if (!structurallyValid.has(firstRole)) continue
    for (let secondIndex = firstIndex + 1; secondIndex < TURNAROUND_ROLES.length; secondIndex += 1) {
      const secondRole = TURNAROUND_ROLES[secondIndex]
      if (!structurallyValid.has(secondRole)) continue
      const overlapRatio = turnaroundCropOverlapRatio(crops![firstRole]!, crops![secondRole]!)
      if (overlapRatio > MAX_TURNAROUND_OVERLAP_RATIO + NORMALIZED_EPSILON) {
        issues.push({
          code: 'excessive-overlap',
          roles: [firstRole, secondRole],
          message: `${TURNAROUND_ROLE_LABELS[firstRole]}与${TURNAROUND_ROLE_LABELS[secondRole]}重叠 ${Math.round(overlapRatio * 100)}%，超过 ${Math.round(MAX_TURNAROUND_OVERLAP_RATIO * 100)}% 上限`,
        })
      }
    }
  }

  return { valid: issues.length === 0, issues }
}

export function isCompleteValidTurnaroundCrops(
  crops: Partial<Record<TurnaroundRole, NormalizedCrop>> | null | undefined,
): crops is TurnaroundCrops {
  return validateTurnaroundCrops(crops).valid
}
