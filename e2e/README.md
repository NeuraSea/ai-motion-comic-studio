# Offline browser E2E

`npm run test:e2e:offline` is the first strict browser slice for the Manju MVP.
It starts from a new temporary SQLite runtime and drives the production build
through:

1. empty source editor;
2. source input and a durable `story.generate` Job;
3. six durable storyboard image Jobs;
4. a real WAV upload and OpenCut timeline attachment;
5. the production FFmpeg export Job;
6. all seven production QC checks and the release gate;
7. a browser-initiated MP4 download followed by bundled `ffprobe` assertions.

The text and image Provider boundaries are deterministic and test-only. The
E2E server refuses to start without `MANJU_E2E=1`, stores everything in the
temporary runtime, and fails any unexpected server-side outbound `fetch`. The
browser also blocks and reports non-local HTTP requests. No production route,
UI state, or job is changed to return a mock success.

Prerequisites:

```sh
pip install playwright
npm run test:e2e:offline
```

The harness uses an installed Google Chrome/Chromium when available. In a
minimal CI image, install Playwright Chromium first with
`python3 -m playwright install chromium`, or set `MANJU_E2E_BROWSER` to an
explicit Chromium-family executable.

Evidence is written under the ignored `output/playwright/` directory. This
slice intentionally does not test paid Provider credentials, Seedance, the
full OpenCut compositor, or a service restart in the middle of a browser run.

`npm run test:e2e:offline:faults` runs the complementary browser failure
paths. It proves source/Story recovery after a page refresh, UI cancellation
of a Provider-waiting image Job, and recovery of the same durable Job after a
process crash. The restart case deliberately expects
`PROVIDER_SUBMISSION_OUTCOME_UNKNOWN`: a non-idempotent image request that was
already submitted must fail closed without a second Provider call.

## Recovery golden: audio timing and OpenCut canonical quarantine

`npm run test:e2e:recovery` exercises two fail-closed recovery paths against a
fresh SQLite runtime and the production browser build. The test-only server
authors the incidents directly as durable records; it does not call a text,
image, speech, or video Provider.

First, a `STALE_AUDIO_TIMING` Seedance Job is opened from Task Center. The UI
must route to the affected stage-3 line, explain the old and current immutable
audio bindings, and require the user to enter stage 4 explicitly. Only an
explicit click runs the free single-shot Seedance preflight; the test stops at
the paid confirmation button and proves that no TTS or Seedance call occurred.

Second, the same episode starts with a compatible canonical OpenCut revision
followed by an authoritative head containing an unknown element, effect, and
animation. The UI must quarantine that exact head before reconcile, disable
editing/playback, make the raw authoritative JSON downloadable, mark the head
itself non-restorable, and allow a compatible immutable history revision to be
restored as a new head. The original incompatible revision remains unchanged
in history. The harness then authors a canonical head whose future effect is
valid OpenCut data but outside Manju's audited renderer subset. Preview must
reject approximation, expose the exact `UNSUPPORTED_TIMELINE` path, and
download a revision/ETag-pinned rescue envelope whose unknown effect and
vendor fields round-trip unchanged. Opening and closing Preview must create no
new timeline revision. Browser and server network tripwires reject every
external request; evidence is written to `output/recovery-golden/`.

## Per-shot visual-analysis golden

`npm run test:e2e:per-shot-visual` starts a fresh six-shot Episode whose real
storyboard and character-view Assets are authored inside the temporary media
store. It selects two deliberately ambiguous shots, proves the fast Seedance
preflight returns both recoveries together, and then uses the prominent batch
action to atomically admit two independently runnable durable multimodal child
Jobs. Every shot card also exposes its own analysis action outside the
paid-selection checkbox; the test runs a third, unselected shot and verifies
that neither its checkbox nor the first two completed results are changed.

After a hard page refresh, all three shot-local results must be recovered from
their durable Jobs without another model call. A final free Seedance preflight
must carry their exact two child Job IDs for the first two shots and the exact
one-shot Job ID for the third. The test stops at paid confirmation. Structured
vision is a deterministic in-process boundary with the persisted `free-llm`
platform policy; image, speech, Seedance, paid, and external-network calls stay
at zero. Evidence is written to
`output/per-shot-visual-analysis-golden/`.

## Audio-first five-stage acceptance

`npm run test:e2e:audio-first` is the unified five-stage golden. It starts from
an empty temporary SQLite runtime and drives the production UI through a
1,000+ character manuscript, a six-shot Story, manually locked character and
location candidates, and a human-confirmed local three-view split. It then
edits one shot attribute and one dialogue line through the real script UI,
proves that the resulting source revision makes the old visual bindings
inadmissible, and recreates the visual locks for the new revision.

The remaining stages generate six mixed narration/character lines as locally
synthesized unequal WAV Assets, generate six deterministic storyboard Assets
with the exact locked front/side/back character slot plus location reference,
and run Seedance's free authority preflight for all six shots. The test then
persists same-source managed subtitles, applies the audited Agentic OpenCut
timing repair, renders a formal 1920x1080 FFmpeg export, runs all seven QC
checks, and downloads the gated MP4. It asserts that the original six equal
Story edit points are conformed to the measured speech envelope before export.
Finally, it reloads the browser and hard-kills/restarts the service against the
same runtime, then verifies the exact Story revision, visual locks, timeline,
export, QC report, and Job count are recoverable.

This is a zero-paid-call acceptance, not evidence from a real paid Provider.
Text and image boundaries are deterministic and E2E-only; speech reads local
system-TTS WAV files; Seedance stops after preflight and never confirms or
submits its six billable video tasks. Browser and server outbound-network
tripwires fail the run on any unexpected request. The JSON report separately
records deterministic boundary calls before restart, zero calls after restart,
and zero external/billable calls. Artifacts are written to
`output/audio-first-e2e/`.

## Audio-driven browser performance Spike

`npm run test:e2e:performance-spike` executes the 45-second-class browser
quick-export acceptance baseline required before enabling that path by
default. It uses a fresh SQLite runtime and a real production build. The Story
still starts with a 45-second target and nine equal draft slots, but those
draft timings are deliberately not accepted as the final edit. Nine unequal,
frame-aligned local narration WAVs are probed and persisted first; their real
durations then drive every visual cut, dialogue clip, subtitle cue, preview,
and export assertion. The Spike verifies:

- a 45-second-target, 9:16 Story with nine real vertical PNG Assets;
- a browser-authored Story revision followed by nine locally synthesized
  Chinese narration WAV Assets and nine automatically materialized sentence
  subtitle cues;
- the audited Agentic preview/apply path repairing a deliberately
  collision-shifted dialogue tail through OpenCut timing operations, with the
  persisted timeline changing from 45.5 seconds to the real 45-second speech
  envelope before preview or export;
- OpenCut preview/playback, cancellation during active frame encoding, and a
  completed 720x1280 H.264/AAC browser MP4 download;
- exact timeline-revision recovery after a page refresh and a hard service
  restart;
- decoded sync markers at every audio-derived picture cut (100ms maximum
  gate), including proof that the cuts do not follow the equal Story slots;
- sampled page-target JS heap and sampled Chrome process-tree RSS.

No paid Provider is contacted. The server rejects unexpected outbound
`fetch`, Chrome blocks non-local HTTP, and the report records the deterministic
text/image test-boundary calls separately from billable Provider calls. Real
narration is produced by offline system TTS (`say`/Tingting on macOS, or
`espeak`/`espeak-ng` when installed); the harness fails instead of presenting
tones as narration when no offline TTS exists.

Artifacts are written to `output/performance-spike/`:

- `report.json` — machine-readable timings, memory scope, persistence evidence,
  Provider evidence, and per-boundary A/V sync results;
- `report.md` — concise human-readable result;
- `browser-45s-9x16.mp4` — downloaded browser quick export;
- `recovered-timeline.png` — UI after hard-restart recovery.
