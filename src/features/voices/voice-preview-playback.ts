export interface AudioPlayedRanges {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

export interface VoicePreviewPlaybackEvidence {
  version: 'html-media-played-v1'
  durationSeconds: number
  ranges: Array<{
    startSeconds: number
    endSeconds: number
  }>
}

function millisecond(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

/**
 * A media `ended` event only proves that the playhead reached the tail. This
 * additionally requires the browser's actually-played ranges to cover the
 * whole preview, so seeking to the end cannot unlock a human acceptance.
 */
export function audioPlaybackCoversDuration(
  played: AudioPlayedRanges,
  duration: number,
  toleranceSeconds = 0.2,
): boolean {
  return createAudioPlaybackEvidence(played, duration, toleranceSeconds) !== null
}

export function createAudioPlaybackEvidence(
  played: AudioPlayedRanges,
  duration: number,
  toleranceSeconds = 0.2,
): VoicePreviewPlaybackEvidence | null {
  if (!Number.isFinite(duration) || duration <= 0
    || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0
    || played.length < 1 || played.length > 64) return null

  const ranges: Array<{ start: number; end: number }> = []
  for (let index = 0; index < played.length; index += 1) {
    const start = played.start(index)
    const end = played.end(index)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
      || end > duration + toleranceSeconds) return null
    ranges.push({ start, end })
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  if (ranges[0]!.start > toleranceSeconds) return null

  const merged = [{ ...ranges[0]! }]
  for (const range of ranges.slice(1)) {
    const current = merged[merged.length - 1]!
    if (range.start > current.end + toleranceSeconds) return null
    current.end = Math.max(current.end, range.end)
  }
  if (merged[merged.length - 1]!.end < duration - toleranceSeconds) return null
  return {
    version: 'html-media-played-v1',
    durationSeconds: millisecond(duration),
    ranges: merged.map((range) => ({
      startSeconds: millisecond(range.start),
      endSeconds: millisecond(Math.min(duration, range.end)),
    })),
  }
}
