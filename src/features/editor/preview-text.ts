import {
  isTimelineElementHidden,
  isTimelineTrackHidden,
  type EditorSceneTracks,
} from '@manju/opencut-editor'

export interface PreviewTextCue {
  id: string
  text: string
}

function previewText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
  return text && text.length <= 10_000 ? text : null
}

/** The deliberately small WYSIWYG subset shared with the formal subtitle export path. */
export function activePreviewTextCues(
  tracks: EditorSceneTracks,
  timelineTime: number,
): PreviewTextCue[] {
  return tracks.overlay.flatMap((track) => {
    if (track.type !== 'text' || isTimelineTrackHidden(track)) return []
    return track.elements.flatMap((element): PreviewTextCue[] => {
      if (element.type !== 'text'
        || isTimelineElementHidden(track, element)
        || timelineTime < element.startTime
        || timelineTime >= element.startTime + element.duration) return []
      const text = previewText(
        typeof element.params?.text === 'string' ? element.params.text : element.name,
      )
      return text ? [{ id: element.id, text }] : []
    })
  })
}
