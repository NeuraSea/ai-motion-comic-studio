# OpenCut Classic controlled extraction

This is **not** a rewritten imitation of OpenCut and it is not a copy of the
OpenCut UI. It is a small, reviewable extraction of real OpenCut Classic editor
logic pinned by [UPSTREAM_COMMIT](./UPSTREAM_COMMIT). Manju owns all React,
layout, styling, and product copy; the extracted functions own timeline
snapping/placement, command-driven editing, and the wired seek/zoom/element
drag/resize interaction semantics.

## Extracted upstream paths

- `apps/web/src/timeline/scale.ts`
- `apps/web/src/timeline/{pixel-utils,zoom-utils}.ts`
- `apps/web/src/timeline/components/interaction.ts`
- `apps/web/src/timeline/controllers/{seek-controller,zoom-controller,element-interaction-controller,resize-controller}.ts`
- `apps/web/src/timeline/components/{drop-target,layout,track-layout}.ts`
- `apps/web/src/timeline/{drag-utils,element-snap-source,playhead-snap-source,animation-snap-points}.ts`
- `apps/web/src/timeline/group-move/snap.ts`
- `apps/web/src/animation/{keyframe-query,path}.ts`
- The timeline content-width/padding/viewport-floor slice from
  `apps/web/src/timeline/components/index.tsx`
- `apps/web/src/timeline/snapping/{types,build,resolve,threshold}.ts`
- `apps/web/src/timeline/placement/{types,compatibility,overlap,insert-index,main-track,resolve}.ts`
- `apps/web/src/timeline/group-move/{types,build-group,resolve-move,track-placement}.ts`
- `apps/web/src/timeline/group-resize/{types,compute-resize}.ts`
- `buildResizeMembers` and `hasResizeChanges` from
  `apps/web/src/timeline/controllers/resize-controller.ts`
- `apps/web/src/commands/base-command.ts`
- `apps/web/src/commands/timeline/element/{move-elements,update-elements,split-elements}.ts`
- `apps/web/src/core/managers/commands.ts`
- `apps/web/src/timeline/{track-element-update,update-pipeline,tracks}.ts`
- `apps/web/src/timeline/placement/track-factory.ts`
- `apps/web/src/{animation,ripple,retime,utils}` dependencies enumerated in the
  source manifest
- `apps/web/src/services/video-cache/service.ts`
- `apps/web/src/services/renderer/scene-exporter.ts`

The corresponding local files retain upstream implementation bodies. Original
and local SHA-256 hashes are recorded in
[UPSTREAM_SOURCES.json](./UPSTREAM_SOURCES.json).

## Deliberate patch set

1. Replace application aliases with relative extracted modules or narrow
   `src/ports/*` compatibility modules.
2. Replace the WASM media-time boundary with `src/ports/media-time.ts`; its
   frame rounding follows the pinned Rust implementation for rates whose
   ticks-per-frame is integral.
3. Replace the seek/zoom/element/resize controllers' React event types with a structural
   `src/ports/browser-events.ts` port. React and native event objects satisfy
   it without bringing OpenCut React code into Manju.
4. Route animation-path graphic/effect predicate imports through the exact
   narrow `src/ports/animation-param-path.ts` subset. The keyframe query's
   color formatter uses OpenCut's upstream `culori@4.0.2` dependency and exact
   linear-RGBA formatter in the params compatibility port.
5. Extract only the two pure resize helpers from the React controller and make
   the otherwise-private change detector exportable.
6. Extract only `isRetimableElement` from the broader element utility module.
7. Reformat only touched imports and normalize one CRLF-only source file.

The media-time port preserves OpenCut's integer-tick invariant, its upstream
constant of 120,000 ticks/second, and its standard frame-rate rounding without
pulling `opencut-wasm` or the complete renderer into the host bundle. The
timeline/editor-core ports are the minimum structural host needed by the
extracted commands; no OpenCut React, Zustand, IndexedDB, or OPFS code is
present. The two renderer sources are kept verbatim here as reviewable
provenance. Manju's browser adapter uses their Mediabunny
`CanvasSource`/`BufferTarget` export lifecycle and sequential `CanvasSink`
cache semantics, but accepts only the smaller immutable `RenderSemanticPlan`
subset and never imports OpenCut UI or stores.

## Honest boundary

The checked-in algorithms support existing-track group moves with collision
checks, bounded/frame-rounded trims, element splitting (including animation
channels and constant-rate retime spans), in-memory undo/redo, and the complete
OpenCut click-to-seek, wheel/anchored-zoom, element drag/drop, and resize
controllers. The Manju facade exposes new-track drag targets and atomic
move/update/property command commits. Manju's own React timeline now forwards
seek, zoom, element drag/cross-track drop, and two-sided resize events to these
facades; committed command results are serialized through `ManjuStorageAdapter`
as immutable SQLite timeline revisions. That persistence lives in the Manju
host, not in this extraction and not in an OpenCut cloud backend.

The boundary still does not expose OpenCut's selection-marquee, keyframe-drag,
external-media drag, ripple-mode controllers, or full effect/mask compositor.
The Manju host now has a gated 720p browser review exporter for the shared
semantic subset; it is not the complete OpenCut renderer and does not replace
the durable FFmpeg/QC publishing path. Split redo retains upstream
`Command.redo()` behavior and therefore allocates a fresh right-side UUID.

## Updating upstream

Do not silently copy from another revision. Pin the new commit, recopy the
listed files, reapply the import-only patch set, update the manifest hashes,
rerun `npm --prefix apps/opencut-editor run verify`, and review every algorithm
diff before changing `UPSTREAM_COMMIT`.
