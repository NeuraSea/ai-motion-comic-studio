export const EDITOR_LAYOUT_STORAGE_KEY = 'manju.editor-layout.v1'

export const DEFAULT_INSPECTOR_WIDTH_PX = 318
export const MIN_INSPECTOR_WIDTH_PX = 260
export const MAX_INSPECTOR_WIDTH_PX = 720
export const DEFAULT_TIMELINE_HEIGHT_PX = 420
export const MIN_TIMELINE_HEIGHT_PX = 180

export interface EditorLayoutPreferences {
  inspectorWidthPx: number
  timelineHeightPx: number | null
}

export const DEFAULT_EDITOR_LAYOUT: Readonly<EditorLayoutPreferences> = Object.freeze({
  inspectorWidthPx: DEFAULT_INSPECTOR_WIDTH_PX,
  // null preserves the OpenCut timeline's content-derived initial height.
  timelineHeightPx: null,
})

export function clampNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

export function clampInspectorWidth(value: number, availableWidth = Number.POSITIVE_INFINITY): number {
  const responsiveMaximum = Number.isFinite(availableWidth)
    ? Math.max(MIN_INSPECTOR_WIDTH_PX, Math.min(MAX_INSPECTOR_WIDTH_PX, availableWidth - 320))
    : MAX_INSPECTOR_WIDTH_PX
  return clampNumber(value, MIN_INSPECTOR_WIDTH_PX, responsiveMaximum)
}

export function clampTimelineHeight(value: number, availableHeight: number): number {
  const responsiveMaximum = Math.max(
    MIN_TIMELINE_HEIGHT_PX,
    Math.min(Math.round(availableHeight * 0.76), availableHeight - 220),
  )
  return clampNumber(value, MIN_TIMELINE_HEIGHT_PX, responsiveMaximum)
}

export function parseEditorLayoutPreferences(raw: string | null): EditorLayoutPreferences {
  if (!raw) return { ...DEFAULT_EDITOR_LAYOUT }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const inspectorWidthPx = typeof parsed.inspectorWidthPx === 'number'
      ? clampInspectorWidth(parsed.inspectorWidthPx)
      : DEFAULT_INSPECTOR_WIDTH_PX
    const timelineHeightPx = typeof parsed.timelineHeightPx === 'number'
      ? clampNumber(parsed.timelineHeightPx, MIN_TIMELINE_HEIGHT_PX, 1600)
      : null
    return { inspectorWidthPx, timelineHeightPx }
  } catch {
    return { ...DEFAULT_EDITOR_LAYOUT }
  }
}

export function serializeEditorLayoutPreferences(preferences: EditorLayoutPreferences): string {
  return JSON.stringify({
    inspectorWidthPx: clampInspectorWidth(preferences.inspectorWidthPx),
    timelineHeightPx: preferences.timelineHeightPx === null
      ? null
      : clampNumber(preferences.timelineHeightPx, MIN_TIMELINE_HEIGHT_PX, 1600),
  })
}
