import type {
  EditorSceneTracks,
  EditorTimelineElement,
  ElementPropertyUpdateEntry,
} from '@manju/opencut-editor'

import {
  buildVisualUniformScaleMotionAnimation,
  readVisualUniformScaleMotionDraft,
  type VisualUniformScaleMotion,
  type VisualUniformScaleStrength,
} from './visual-uniform-scale-motion'

export const AGENTIC_VISUAL_MOTION_STRATEGY = 'opencut-safe-uniform-scale-v1' as const

export interface AgenticVisualMotionShot {
  id: number
  storyId?: string
  code: string
  framing?: string
  movement?: string
}

export interface AgenticVisualMotionRecommendation {
  trackId: string
  elementId: string
  shotId: string | null
  shotCode: string
  motion: Exclude<VisualUniformScaleMotion, 'none'>
  strength: VisualUniformScaleStrength
  reason: string
  expectedDuration: number
  expectedAnimations: Record<string, unknown> | undefined
  animations: Record<string, unknown>
}

export interface AgenticVisualMotionSkip {
  trackId: string
  elementId: string
  shotCode: string
  reason: string
}

export interface AgenticVisualMotionPlan {
  version: 1
  strategy: typeof AGENTIC_VISUAL_MOTION_STRATEGY
  recommendations: AgenticVisualMotionRecommendation[]
  skipped: AgenticVisualMotionSkip[]
}

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, ' ') ?? ''
}

function shotForElement(
  shots: readonly AgenticVisualMotionShot[],
  element: EditorTimelineElement,
): AgenticVisualMotionShot | null {
  const params = element.params ?? {}
  const hasStoryShotId = Object.hasOwn(params, 'storyShotId')
  const rawStoryShotId = params.storyShotId
  const storyShotId = typeof rawStoryShotId === 'string'
    && rawStoryShotId.length > 0
    && rawStoryShotId.trim() === rawStoryShotId
    ? rawStoryShotId
    : null
  if (hasStoryShotId && storyShotId === null) return null

  const hasNumericShotId = Object.hasOwn(params, 'shotId')
  const rawNumericShotId = params.shotId
  const numericShotId = typeof rawNumericShotId === 'number'
    && Number.isSafeInteger(rawNumericShotId)
    ? rawNumericShotId
    : typeof rawNumericShotId === 'string'
      && /^-?(?:0|[1-9]\d*)$/.test(rawNumericShotId)
      && Number.isSafeInteger(Number(rawNumericShotId))
      ? Number(rawNumericShotId)
      : null
  if (hasNumericShotId && numericShotId === null) return null
  if (!hasStoryShotId && !hasNumericShotId) return null

  const storyMatches = storyShotId === null
    ? []
    : shots.filter((shot) => shot.storyId === storyShotId)
  const numericMatches = numericShotId === null
    ? []
    : shots.filter((shot) => shot.id === numericShotId)
  if ((hasStoryShotId && storyMatches.length !== 1)
    || (hasNumericShotId && numericMatches.length !== 1)) return null
  if (hasStoryShotId && hasNumericShotId && storyMatches[0] !== numericMatches[0]) return null
  return (storyMatches[0] ?? numericMatches[0]) ?? null
}

function recommendationForShot(shot: AgenticVisualMotionShot): {
  motion: Exclude<VisualUniformScaleMotion, 'none'>
  strength: VisualUniformScaleStrength
  reason: string
} | null {
  const movement = normalized(shot.movement)
  const framing = normalized(shot.framing)
  if (/静止|固定|定格|无运镜|锁定/.test(movement)) return null

  // A compound instruction must never be silently reduced to the scale-only
  // portion. Those moves require position/rotation/camera semantics that this
  // audited OpenCut subset deliberately does not own.
  if (/横移|平移|摇镜|摇摄|环绕|跟拍|跟随|手持|升降|旋转|甩镜|\bpan(?:ning)?\b|\btilt(?:ing)?\b|\borbit(?:ing)?\b|\bfollow(?:ing)?\b|\bhandheld\b/.test(movement)) {
    return null
  }

  const slow = /轻微|缓慢|慢速|slow|gentle/.test(movement)
  const strength: VisualUniformScaleStrength = slow ? 4 : 8
  const pushes = /推近|推进|前推|靠近|压近|放大|zoom in|dolly in/.test(movement)
  const pulls = /拉远|后退|退远|远离|缩小|揭示全景|zoom out|dolly out/.test(movement)
  if (movement && pushes === pulls) return null
  if (pushes) {
    return {
      motion: 'push-in',
      strength,
      reason: `运镜“${shot.movement?.trim()}”映射为中心轻推近`,
    }
  }
  if (pulls) {
    return {
      motion: 'pull-out',
      strength,
      reason: `运镜“${shot.movement?.trim()}”映射为中心轻拉远`,
    }
  }

  // Never counterfeit a pan, tilt, orbit, follow, or handheld move with a
  // scale animation. Framing is only a conservative fallback when the Story
  // carries no movement instruction at all.
  if (movement) return null
  if (/特写|近景|close[- ]?up/.test(framing)) {
    return { motion: 'push-in', strength: 4, reason: `无运镜指令；按“${shot.framing}”保守轻推近` }
  }
  if (/远景|全景|大全景|wide|establishing/.test(framing)) {
    return { motion: 'pull-out', strength: 4, reason: `无运镜指令；按“${shot.framing}”保守轻拉远` }
  }
  return null
}

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => same(value, right[index]))
  }
  if (typeof left !== 'object' || left === null
    || typeof right !== 'object' || right === null) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && same(leftRecord[key], rightRecord[key])
    ))
}

/**
 * Produce a side-effect-free OpenCut property plan. The planner deliberately
 * skips existing user motion and every renderer semantic outside the audited
 * static-image uniform-scale subset.
 */
export function planAgenticVisualMotion(
  tracks: EditorSceneTracks,
  shots: readonly AgenticVisualMotionShot[],
): AgenticVisualMotionPlan {
  const recommendations: AgenticVisualMotionRecommendation[] = []
  const skipped: AgenticVisualMotionSkip[] = []
  for (const track of [tracks.main, ...tracks.overlay]) {
    if (track.hidden === true || track.type !== 'video') continue
    for (const element of track.elements) {
      if (element.hidden === true || element.type !== 'image') continue
      const shot = shotForElement(shots, element)
      const shotCode = shot?.code ?? element.name ?? element.id
      const skip = (reason: string) => skipped.push({
        trackId: track.id,
        elementId: element.id,
        shotCode,
        reason,
      })
      if (!shot) {
        skip('未找到唯一且一致的当前剧本镜头绑定，不猜测运镜')
        continue
      }
      const current = readVisualUniformScaleMotionDraft(element)
      if (!current.editable) {
        skip(current.reason)
        continue
      }
      if (current.draft.motion !== 'none') {
        skip('已存在人工镜头运动，Agent 不覆盖')
        continue
      }
      const decision = recommendationForShot(shot)
      if (!decision) {
        skip(shot.movement?.trim()
          ? `运镜“${shot.movement.trim()}”不属于已审核的中心缩放子集`
          : '缺少可安全映射的运镜或景别证据')
        continue
      }
      try {
        recommendations.push({
          trackId: track.id,
          elementId: element.id,
          shotId: shot.storyId ?? null,
          shotCode,
          ...decision,
          expectedDuration: element.duration,
          expectedAnimations: element.animations
            ? structuredClone(element.animations)
            : undefined,
          animations: buildVisualUniformScaleMotionAnimation({
            animations: element.animations,
            durationTicks: element.duration,
            motion: decision.motion,
            strength: decision.strength,
          }),
        })
      } catch (cause) {
        skip(cause instanceof Error ? cause.message : '镜头动画无法安全编译')
      }
    }
  }
  return {
    version: 1,
    strategy: AGENTIC_VISUAL_MOTION_STRATEGY,
    recommendations,
    skipped,
  }
}

/**
 * Convert a still-valid preview into one OpenCut UpdateElementsCommand input.
 * A duration or animation drift invalidates the whole plan; partial apply is
 * never allowed.
 */
export function updatesForAgenticVisualMotion(
  tracks: EditorSceneTracks,
  plan: AgenticVisualMotionPlan,
): ElementPropertyUpdateEntry[] | null {
  if (plan.version !== 1 || plan.strategy !== AGENTIC_VISUAL_MOTION_STRATEGY) return null
  const allTracks = [...tracks.overlay, tracks.main, ...tracks.audio]
  const updates: ElementPropertyUpdateEntry[] = []
  const keys = new Set<string>()
  for (const recommendation of plan.recommendations) {
    const key = `${recommendation.trackId}\u0000${recommendation.elementId}`
    if (keys.has(key)) return null
    keys.add(key)
    const matchingTracks = allTracks.filter((candidate) => candidate.id === recommendation.trackId)
    if (matchingTracks.length !== 1) return null
    const track = matchingTracks[0]
    const matchingElements = track.elements.filter((candidate) => candidate.id === recommendation.elementId)
    if (matchingElements.length !== 1) return null
    const element = matchingElements[0]
    if (!track || track.type !== 'video' || track.hidden === true
      || !element || element.type !== 'image' || element.hidden === true
      || element.duration !== recommendation.expectedDuration
      || !same(element.animations, recommendation.expectedAnimations)) return null
    const current = readVisualUniformScaleMotionDraft(element)
    if (!current.editable || current.draft.motion !== 'none') return null
    let compiled: Record<string, unknown>
    try {
      compiled = buildVisualUniformScaleMotionAnimation({
        animations: element.animations,
        durationTicks: element.duration,
        motion: recommendation.motion,
        strength: recommendation.strength,
      })
    } catch {
      return null
    }
    if (!same(compiled, recommendation.animations)) return null
    updates.push({
      trackId: recommendation.trackId,
      elementId: recommendation.elementId,
      // Never submit caller-owned plan data. Recompile the audited subset from
      // the still-current OpenCut element and return that exact safe patch.
      patch: { animations: structuredClone(compiled) },
    })
  }
  return updates
}
