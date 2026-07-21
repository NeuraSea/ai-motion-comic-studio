# Manju OpenCut editor boundary

This package is the first integration slice between Manju and the pinned
OpenCut Classic engine extraction. It deliberately contains no OpenCut UI:
Manju keeps its own visual language, React components, Chinese copy, and product
flows. The adapter exposes plain timeline DTOs while delegating interaction
decisions to real OpenCut algorithms.

## Real behavior already delegated to OpenCut

- Aggregate independent clip-edge/playhead/bookmark/keyframe snap sources.
- Derive snap tolerance from zoom and pixel threshold.
- Resolve the closest timeline snap point.
- Enforce element-to-track compatibility (`image` uses a video track).
- Reject overlapping placement while allowing adjacent clip edges.
- Choose existing or new tracks for explicit, first-available, preferred-index,
  above-source, and always-new strategies.
- Enforce OpenCut's main-track start-at-zero rule.
- Build and resolve real OpenCut group moves, including existing-track
  collision rejection.
- Execute upstream move, update, and split command classes.
- Compute frame-rounded, neighbor/source-bounded left/right trims.
- Split source trims and animation channels at an absolute timeline time.
- Use OpenCut's command manager for in-memory undo/redo round trips.
- Qualify click-to-seek gestures with OpenCut's exact 5 px / 500 ms rules.
- Convert ruler/track pixels to integer media time and optionally frame-snap.
- Classify wheel gestures and apply OpenCut's exponential, capped zoom delta.
- Preserve OpenCut's playhead-anchor threshold and debounced view-state saves.
- Use OpenCut's strict `> 5 px` element-drag threshold and click suppression.
- Resolve vertical drop targets from pinned track heights/gaps and create-track fallbacks.
- Snap moving group start/end edges against clip, playhead, and animation-keyframe sources.
- Preview and commit neighbor/source-bounded, frame-rounded group resizes.
- Commit controller-resolved moves/updates through pinned command classes so undo/redo remains authoritative.

The implementation commit is available at runtime through `engine.provenance`.
Third-party source provenance and patches live in
`../../third_party/OpenCut-Classic`.

## Boundary

Manju UI imports only `src/index.ts` and calls `createOpenCutTimelineEngine()`,
`createOpenCutCommandEditor()`, or `createOpenCutTimelineInteractions()`. It
must not import OpenCut components, Zustand stores, or browser storage. This
prevents upstream styling and persistence from leaking into the product and
lets the server remain authoritative.

`createOpenCutCommandEditor()` accepts plain in-memory scene tracks. Its
controller facade is now connected to Manju's own React timeline for seek,
wheel/playhead-anchored zoom, selection, existing/new-track clip drag,
frame-rounded resize, split, delete, undo/redo, audio-property updates, and
atomic managed-subtitle cue-set replacement. Command results are serialized
through `ManjuStorageAdapter` as immutable SQLite-backed timeline revisions.

Selection marquee, keyframe drag, external-media drag, ripple-mode UI, and the
remaining effect/advanced-mask compositor still require integration. The host now compiles a
deep-frozen `RenderSemanticPlan` for one strict MVP subset and passes that same
plan to its preview and gated 720p browser review exporter. Unsupported
composition is rejected before playback; WebCodecs/Mediabunny codec absence
keeps quick export disabled. Split redo intentionally follows OpenCut's
base-command behavior and creates a fresh right-side UUID.

## React hookup example (Manju-owned UI)

Keep the latest host callbacks and DOM refs in a Manju ref. Construct the
facade once; React events are structurally compatible with its UI-neutral
event ports.

```tsx
const configRef = useRef<OpenCutTimelineInteractionConfig>(config);
configRef.current = config;

const interactionsRef = useRef<OpenCutTimelineInteractions | null>(null);
interactionsRef.current ??= createOpenCutTimelineInteractions({
  getConfig: () => configRef.current,
  initialZoom: savedView?.zoomLevel,
});
const interactions = interactionsRef.current;

const zoomLevel = useSyncExternalStore(
  interactions.subscribeZoom,
  () => interactions.zoomLevel,
);
useLayoutEffect(() => interactions.applyZoomLayout(), [interactions, zoomLevel]);
useEffect(() => interactions.bindPreventBrowserZoom(), [interactions]);
useEffect(() => () => interactions.destroy(), [interactions]);

return (
  <>
    <div
      ref={rulerScrollRef}
      onMouseDown={(event) => interactions.onRulerMouseDown(event)}
      onClick={(event) => interactions.onRulerClick(event)}
    />
    <div
      ref={tracksScrollRef}
      onMouseDown={(event) => interactions.onTracksMouseDown(event)}
      onClick={(event) => interactions.onTracksClick(event)}
      onWheel={(event) => interactions.onWheel(event)}
      onScroll={interactions.saveScrollPosition}
    />
  </>
);
```

The host must call both `onMouseDown` and `onClick` for the same surface;
OpenCut deliberately rejects a click without its matching pending session.

## Element drag/resize hookup

Use one `OpenCutCommandEditor` as the command/history authority. Resize preview
may live in temporary Manju render state, but final move/update commits must be
delegated to its atomic command methods:

```tsx
const commandEditor = createOpenCutCommandEditor({ tracks, frameRate });
const elementInteractions = createOpenCutElementInteractions({
  getConfig: () => ({
    // DOM/state/selection readers omitted here for brevity.
    ...interactionReadersRef.current,
    getTracks: () => commandEditor.getTracks(),
    commitElementMoves: (commit) => commandEditor.commitElementMoves(commit),
    discardResizePreview: clearResizePreview,
    previewResizeElements: setResizePreview,
    commitResizeElements: (updates) =>
      commandEditor.commitElementUpdates({ updates }),
  }),
});

const snapshot = useSyncExternalStore(
  elementInteractions.subscribe,
  elementInteractions.getSnapshot,
);

<div
  style={{ height: getOpenCutTrackHeight({ trackType: track.type }) }}
  onMouseDown={(event) => elementInteractions.onElementMouseDown({
    event, trackId: track.id, elementId: element.id,
  })}
  onClick={(event) => elementInteractions.onElementClick({
    event, trackId: track.id, elementId: element.id,
  })}
/>
```

Build timeline width with `getOpenCutTimelineLayout()`, render clip/playhead
positions with `openCutTimelineTimeToPixels()`, and drive the range input with
`openCutZoomToSlider()` / `openCutSliderToZoom()`. Track height, gap, ruler,
scrollbar, and `zoomMax` values come from `getOpenCutTrackHeight()` and
`OPEN_CUT_TIMELINE_LAYOUT_METRICS`; Manju CSS must not duplicate those values.

## Verify in isolation

```sh
npm --prefix apps/opencut-editor run verify
```

## Current host integration

The root application already translates immutable Manju `timeline_document`
snapshots into `EditorSceneTracks`, forwards its own visual components' events
to these controller/command contracts, and persists only the resulting plain
document through `ManjuStorageAdapter` with ETag conflict handling. In-memory
command objects are never persisted or exposed by the API.

The browser review slice consumes the same pinned timeline revision and Asset
version/SHA-256 pins used by formal FFmpeg export. It supports one contiguous
image/video layer with cover/contain and video trim, trimmed audio clips with
gain/fades/roles/explicit dialogue ducking, and nonoverlapping subtitles. It
accepts two audited compositor slices: OpenCut scalar `animations.opacity`
expressed as one frame-aligned linear fade-in and/or fade-out, plus exactly one
canonical OpenCut `masks` entry of type `rectangle` or `ellipse`. The v3
immutable receipts drive CSS preview, Canvas/WebCodecs review export, and
FFmpeg `fade`/hard-mask filters. Feather, inversion, stroke, rotation, mask
scale, multiple masks, unknown shapes/effects, and compositor semantics
spanning split short-video holds fail closed instead of being approximated.
Property authoring goes through one OpenCut `UpdateElementsCommand`, so mask
and opacity changes retain undo/redo.
uses pinned OpenCut Classic `VideoCache`/`SceneExporter` lifecycle semantics
through a thin Manju Asset adapter and `mediabunny@1.29.1`; it does not import
OpenCut UI. This is a review exporter, not a durable publish path: output is
memory-backed, limited to 10 minutes, and still requires a Chrome-class browser
with AVC/AAC WebCodecs. Formal delivery remains the FFmpeg job plus QC gate.
