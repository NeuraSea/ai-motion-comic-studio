import {
  renderSemanticPlanBoundarySignature,
  type RenderSemanticPlan,
} from '@manju/opencut-editor'

import {
  browserQuickExportBoundarySignature,
  exportRenderSemanticPlanToMp4,
  probeBrowserQuickExport,
} from '../src/features/editor/browser-quick-export'
import type { TimelineMediaManifest } from '../src/features/editor/manju-media-resolver'

interface DualEncoderFixture {
  plan: RenderSemanticPlan
  manifest: TimelineMediaManifest
  expected: {
    planSha256: string
    boundarySignatureSha256: string
  }
}

declare global {
  interface Window {
    __dualEncoderEvidence?: {
      byteLength: number
      planSha256: string
      boundarySignatureSha256: string
      browserBoundarySignatureSha256: string
      timelineRevisionId: string
    }
    __dualEncoderError?: string
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function main(): Promise<void> {
  const fixtureResponse = await fetch('/fixture.json', {
    credentials: 'same-origin',
    redirect: 'error',
  })
  if (!fixtureResponse.ok) throw new Error(`fixture HTTP ${fixtureResponse.status}`)
  const fixture = await fixtureResponse.json() as DualEncoderFixture
  const canonical = renderSemanticPlanBoundarySignature(fixture.plan)
  const browserObserved = browserQuickExportBoundarySignature(fixture.plan)
  const [planSha256, canonicalSha256, browserSha256] = await Promise.all([
    sha256(JSON.stringify(fixture.plan)),
    sha256(canonical),
    sha256(browserObserved),
  ])
  if (planSha256 !== fixture.expected.planSha256) {
    throw new Error('browser received a different immutable RenderSemanticPlan')
  }
  if (canonicalSha256 !== fixture.expected.boundarySignatureSha256
    || browserSha256 !== canonicalSha256) {
    throw new Error('browser quick-export helpers changed semantic boundaries')
  }
  const support = await probeBrowserQuickExport(fixture.plan)
  if (!support.supported) throw new Error(support.reason ?? 'browser quick export unsupported')
  const blob = await exportRenderSemanticPlanToMp4({
    plan: fixture.plan,
    manifest: fixture.manifest,
  })
  if (blob.size < 16) throw new Error('browser quick export returned an empty file')
  const link = document.createElement('a')
  link.id = 'dual-encoder-download'
  link.href = URL.createObjectURL(blob)
  link.download = 'browser-quick-export.mp4'
  link.textContent = 'download browser quick export'
  document.body.append(link)
  window.__dualEncoderEvidence = {
    byteLength: blob.size,
    planSha256,
    boundarySignatureSha256: canonicalSha256,
    browserBoundarySignatureSha256: browserSha256,
    timelineRevisionId: fixture.plan.timelineRevisionId,
  }
  document.body.dataset.status = 'ready'
}

void main().catch((cause: unknown) => {
  window.__dualEncoderError = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
  document.body.dataset.status = 'error'
  document.body.textContent = window.__dualEncoderError
})

