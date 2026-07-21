import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appPath = new URL('../src/App.tsx', import.meta.url)
const timelinePath = new URL('../src/features/editor/OpenCutTimeline.tsx', import.meta.url)

function slice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing boundary: ${start}`)
  assert.ok(endIndex > startIndex, `missing boundary: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('an empty review selection does not erase a succeeded storyboard candidate', async () => {
  const source = await readFile(appPath, 'utf8')
  const refresh = slice(
    source,
    'const refreshSelectedShotMediaReviews',
    'const reconcileReviewedShotMedia',
  )
  const hydration = slice(
    source,
    'const storyboardJobs = currentStoryJobs.filter',
    'const activeJobs = storyboardJobs.filter',
  )

  assert.match(refresh, /\.\.\.\(selectedStoryboard \? \{[\s\S]*imageUrl: selectedStoryboard\.url/)
  assert.doesNotMatch(refresh, /imageUrl: selectedStoryboard\?\.url/)
  assert.match(hydration, /const image = reviewedImage \?\? \(latestReady/)
  assert.doesNotMatch(hydration, /imageUrl: reviewedImage\?\.url/)
})

test('external shot selection seeks while timeline-driven selection does not snap playback', async () => {
  const source = await readFile(timelinePath, 'utf8')
  const externalSync = slice(
    source,
    'useEffect(() => {\n    const nextTracks = commandEditor.getTracks()',
    '\n\n  useEffect(() => {\n    const playback = commandEditor.playback',
  )

  assert.match(source, /timelineDrivenShotSelectionRef = useRef<number \| null>\(null\)/)
  assert.match(externalSync, /timelineDrivenShotSelectionRef\.current === activeShot/)
  assert.match(externalSync, /if \(timelineDriven\) return/)
  assert.match(externalSync, /commandEditor\.playback\.seek\(match\.element\.startTime\)/)
  assert.match(source, /const shotSelectionSeed = shots\.map/)
  assert.match(externalSync, /\}, \[activeShot, commandEditor, shotSelectionSeed\]\)/)
  assert.equal(source.match(/timelineDrivenShotSelectionRef\.current = shot\.id/g)?.length, 2)
})
