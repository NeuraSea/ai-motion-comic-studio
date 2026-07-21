# Third-party notice: OpenCut Classic

This directory contains a source extraction from
[OpenCut Classic](https://github.com/OpenCut-app/OpenCut-Classic) at commit
`cf5e79e919144200294fb9fed22a222592a0aeea`.

- Copyright: 2025-2026 OpenCut
- License: MIT; the complete license text is in [LICENSE](./LICENSE).
- Local use: timeline snapping/placement, group-move collision resolution,
  insert/delete/move/update/split and add-track commands, resize and retime math, animation splitting,
  ripple helpers, command history semantics, click-to-seek orchestration, and
  wheel/playhead-anchored zoom, element drag/drop, drop-target, multi-source
  snapping, and resize orchestration.
- Modifications: application aliases were replaced by narrow local ports. Two
  UI-independent helpers were extracted from the React resize controller, and
  one element predicate was extracted from the larger element utility module.
  React mouse/wheel event imports in the complete seek/zoom controllers were
  replaced by an equivalent structural event compatibility port; the same
  import-only event adaptation is applied to the element/resize controllers.
  OpenCut's `culori@4.0.2` dependency is retained for exact animation
  keyframe color composition.
  The `opencut-wasm` media-time boundary is a local TypeScript compatibility
  port that preserves OpenCut's integer-tick and supported-frame-rate rules.
  The UI-neutral `InsertElementCommand` retains OpenCut's placement, automatic
  track creation, element identity, selection, and history behavior, but does
  not import browser media/project/graphics registries: first-visual canvas/FPS
  side effects are outside this boundary, canonical timing fields are required,
  and graphic definitions are checked structurally by `definitionId`. Other
  extracted commands and timeline algorithms were not intentionally changed. See
  [UPSTREAM_SOURCES.json](./UPSTREAM_SOURCES.json) for per-file hashes and the
  patch ledger.
  The verbatim `VideoCache` and `SceneExporter` sources are retained for the
  browser-render provenance boundary. Manju's thin adapter follows their
  sequential `CanvasSink` cache and Mediabunny
  `Output`/`CanvasSource`/`BufferTarget` lifecycle without importing OpenCut
  React UI, persistence, effects, or skin.

The browser review exporter installs `mediabunny@1.29.1`, matching the minimum
version declared by the pinned OpenCut Classic web application. Mediabunny is
licensed under the Mozilla Public License 2.0 and is used as an unmodified
library dependency; its source and license are distributed by its npm package.

OpenCut and its maintainers do not endorse this application.
