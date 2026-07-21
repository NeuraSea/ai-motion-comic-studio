import type { ElementAnimations } from "../../../third_party/OpenCut-Classic/src/animation/types.js";
import { ElementInteractionController } from "../../../third_party/OpenCut-Classic/src/timeline/controllers/element-interaction-controller.js";
import { ResizeController } from "../../../third_party/OpenCut-Classic/src/timeline/controllers/resize-controller.js";
import { mediaTime } from "../../../third_party/OpenCut-Classic/src/ports/media-time.js";
import type {
	ElementDragView,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "../../../third_party/OpenCut-Classic/src/ports/timeline.js";
import {
	getTimelinePixelsPerSecond,
	timelineTimeToPixels,
} from "../../../third_party/OpenCut-Classic/src/timeline/pixel-utils.js";
import { getTimelineLayoutDimensions } from "../../../third_party/OpenCut-Classic/src/timeline/layout-width.js";
import {
	TIMELINE_BOOKMARK_ROW_HEIGHT_PX,
	TIMELINE_CONTENT_TOP_PADDING_PX,
	TIMELINE_RULER_HEIGHT_PX,
	TIMELINE_SCROLLBAR_SIZE_PX,
	TIMELINE_TRACK_GAP_PX,
	TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX,
} from "../../../third_party/OpenCut-Classic/src/timeline/components/layout.js";
import { getTrackHeight } from "../../../third_party/OpenCut-Classic/src/timeline/components/track-layout.js";
import { TIMELINE_ZOOM_MAX } from "../../../third_party/OpenCut-Classic/src/timeline/scale.js";
import {
	getTimelineZoomMin,
	sliderToZoom,
	zoomToSlider,
} from "../../../third_party/OpenCut-Classic/src/timeline/zoom-utils.js";
import type {
	GroupResizeUpdate,
	ResizeSide,
} from "../../../third_party/OpenCut-Classic/src/timeline/group-resize/types.js";
import type { SnapPoint } from "../../../third_party/OpenCut-Classic/src/timeline/snapping/types.js";
import type {
	CommitElementMovesInput,
	ElementUpdateEntry,
	EditorElementRef,
	EditorFrameRate,
	EditorSceneTracks,
	EditorTimelineElement,
	EditorTrackType,
	TimelineSnapPoint,
	TimelineTicks,
} from "./contracts.js";
import { OPEN_CUT_CLASSIC_COMMIT } from "./opencut-timeline-engine.js";

export interface OpenCutElementMouseEvent {
	button: number;
	clientX: number;
	clientY: number;
	timeStamp: number;
	target: EventTarget;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	currentTarget: HTMLElement;
	stopPropagation(): void;
	preventDefault(): void;
}

export interface OpenCutElementDropTarget {
	trackIndex: number;
	isNewTrack: boolean;
	insertPosition: "above" | "below" | null;
	xPosition: TimelineTicks;
	targetElement: EditorElementRef | null;
}

export type OpenCutElementDragView =
	| { readonly kind: "idle" }
	| {
			readonly kind: "dragging";
			readonly anchorElementId: string;
			readonly trackId: string;
			readonly memberTimeOffsets: ReadonlyMap<string, TimelineTicks>;
			readonly startMouseX: number;
			readonly startMouseY: number;
			readonly startElementTime: TimelineTicks;
			readonly clickOffsetTime: TimelineTicks;
			readonly currentTime: TimelineTicks;
			readonly currentMouseX: number;
			readonly currentMouseY: number;
			readonly dropTarget: OpenCutElementDropTarget | null;
	  };

export interface OpenCutElementInteractionSnapshot {
	dragView: OpenCutElementDragView;
	elementInteractionActive: boolean;
	isResizing: boolean;
}

/** Dynamic Manju-owned ports consumed by the complete upstream controllers. */
export interface OpenCutElementInteractionConfig {
	getZoomLevel(): number;
	getTracksScrollEl(): HTMLDivElement | null;
	getTracksContainerEl(): HTMLDivElement | null;
	getHeaderEl(): HTMLElement | null;
	getTracks(): EditorSceneTracks;
	getActiveProjectFps(): EditorFrameRate | null;
	isShiftHeld(): boolean;
	getSelectedElements(): readonly EditorElementRef[];
	isElementSelected(ref: EditorElementRef): boolean;
	selectElement(ref: EditorElementRef): void;
	handleElementClick(ref: EditorElementRef & { isMultiKey: boolean }): void;
	clearKeyframeSelection(): void;
	getCurrentPlayheadTime(): TimelineTicks;
	isSnappingEnabled(): boolean;
	onSnapPointChange?(snapPoint: TimelineSnapPoint | null): void;
	/** Delegate directly to OpenCutCommandEditor.commitElementMoves(). */
	commitElementMoves(commit: CommitElementMovesInput): void;
	discardResizePreview(): void;
	previewResizeElements(updates: ElementUpdateEntry[]): void;
	/** Delegate to OpenCutCommandEditor.commitElementUpdates({ updates }). */
	commitResizeElements(updates: ElementUpdateEntry[]): void;
}

export interface OpenCutElementInteractions {
	readonly provenance: {
		project: "OpenCut-Classic";
		commit: string;
	};
	getSnapshot(): OpenCutElementInteractionSnapshot;
	subscribe(listener: (snapshot: OpenCutElementInteractionSnapshot) => void): () => void;
	onElementMouseDown(input: {
		event: OpenCutElementMouseEvent;
		trackId: string;
		elementId: string;
	}): void;
	onElementClick(input: {
		event: OpenCutElementMouseEvent;
		trackId: string;
		elementId: string;
	}): void;
	onResizeStart(input: {
		event: OpenCutElementMouseEvent;
		trackId: string;
		elementId: string;
		side: "left" | "right";
	}): void;
	cancelElementInteraction(): void;
	cancelResize(): void;
	destroy(): void;
}

export interface CreateOpenCutElementInteractionsInput {
	getConfig(): OpenCutElementInteractionConfig;
}

export const OPEN_CUT_TIMELINE_LAYOUT_METRICS = Object.freeze({
	zoomMax: TIMELINE_ZOOM_MAX,
	trackGapPx: TIMELINE_TRACK_GAP_PX,
	trackLabelsColumnWidthPx: TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX,
	rulerHeightPx: TIMELINE_RULER_HEIGHT_PX,
	bookmarkRowHeightPx: TIMELINE_BOOKMARK_ROW_HEIGHT_PX,
	scrollbarSizePx: TIMELINE_SCROLLBAR_SIZE_PX,
	contentTopPaddingPx: TIMELINE_CONTENT_TOP_PADDING_PX,
});

function toUpstreamElement(element: EditorTimelineElement): TimelineElement {
	return {
		id: element.id,
		type: element.type,
		name: element.name ?? element.id,
		startTime: mediaTime({ ticks: element.startTime }),
		duration: mediaTime({ ticks: element.duration }),
		trimStart: mediaTime({ ticks: element.trimStart ?? 0 }),
		trimEnd: mediaTime({ ticks: element.trimEnd ?? 0 }),
		...(element.sourceDuration === undefined
			? {}
			: { sourceDuration: mediaTime({ ticks: element.sourceDuration }) }),
		params: { ...(element.params ?? {}) },
		...(element.animations === undefined
			? {}
			: { animations: element.animations as ElementAnimations }),
		...(element.retime === undefined ? {} : { retime: { ...element.retime } }),
	};
}

function toUpstreamTracks(tracks: EditorSceneTracks): SceneTracks {
	return {
		overlay: tracks.overlay.map((track) => ({
			id: track.id,
			name: track.name,
			type: track.type,
			hidden: track.hidden,
			muted: track.muted,
			elements: track.elements.map(toUpstreamElement),
		})),
		main: {
			id: tracks.main.id,
			name: tracks.main.name,
			type: "video",
			hidden: tracks.main.hidden,
			muted: tracks.main.muted,
			elements: tracks.main.elements.map(toUpstreamElement),
		},
		audio: tracks.audio.map((track) => ({
			id: track.id,
			name: track.name,
			type: "audio",
			muted: track.muted,
			elements: track.elements.map(toUpstreamElement),
		})),
	};
}

function findTrackAndElement(
	tracks: SceneTracks,
	ref: EditorElementRef,
): { track: TimelineTrack; element: TimelineElement } | null {
	const track = [...tracks.overlay, tracks.main, ...tracks.audio].find(
		(candidate) => candidate.id === ref.trackId,
	);
	const element = track?.elements.find(
		(candidate) => candidate.id === ref.elementId,
	);
	return track && element ? { track, element } : null;
}

function toHostSnapPoint(snapPoint: SnapPoint | null): TimelineSnapPoint | null {
	return snapPoint ? { ...snapPoint, time: snapPoint.time } : null;
}

function toHostResizeUpdates(
	updates: GroupResizeUpdate[],
): ElementUpdateEntry[] {
	return updates.map((update) => ({
		trackId: update.trackId,
		elementId: update.elementId,
		patch: {
			trimStart: update.patch.trimStart,
			trimEnd: update.patch.trimEnd,
			startTime: update.patch.startTime,
			duration: update.patch.duration,
		},
	}));
}

function toHostDragView(view: ElementDragView): OpenCutElementDragView {
	if (view.kind === "idle") return view;
	return {
		...view,
		memberTimeOffsets: view.memberTimeOffsets,
		dropTarget: view.dropTarget
			? {
					...view.dropTarget,
					xPosition: view.dropTarget.xPosition,
					targetElement: view.dropTarget.targetElement
						? { ...view.dropTarget.targetElement }
						: null,
				}
			: null,
	};
}

/**
 * Facade over the complete pinned ElementInteractionController and
 * ResizeController. React forwards events/refs and renders snapshots; all
 * threshold, px/time, snapping, drop-target, collision, and resize math stays
 * in OpenCut.
 */
export function createOpenCutElementInteractions(
	input: CreateOpenCutElementInteractionsInput,
): OpenCutElementInteractions {
	const elementDepsRef = {
		get current() {
			const config = input.getConfig();
			return {
				viewport: {
					getZoomLevel: () => config.getZoomLevel(),
					getTracksScrollEl: () => config.getTracksScrollEl(),
					getTracksContainerEl: () => config.getTracksContainerEl(),
					getHeaderEl: () => config.getHeaderEl(),
				},
				input: { isShiftHeld: () => config.isShiftHeld() },
				scene: {
					getTracks: () => toUpstreamTracks(config.getTracks()),
					getActiveFps: () => config.getActiveProjectFps(),
				},
				selection: {
					getSelected: () => config.getSelectedElements(),
					isSelected: (ref: EditorElementRef) => config.isElementSelected(ref),
					select: (ref: EditorElementRef) => config.selectElement(ref),
					handleClick: (args: EditorElementRef & { isMultiKey: boolean }) =>
						config.handleElementClick(args),
					clearKeyframeSelection: () => config.clearKeyframeSelection(),
				},
				playback: {
					getCurrentTime: () =>
						mediaTime({ ticks: config.getCurrentPlayheadTime() }),
				},
				timeline: {
					moveElements: (commit: CommitElementMovesInput) =>
						config.commitElementMoves(commit),
				},
				snap: {
					isEnabled: () => config.isSnappingEnabled(),
					onChange: (snapPoint: SnapPoint | null) =>
						config.onSnapPointChange?.(toHostSnapPoint(snapPoint)),
				},
			};
		},
	};
	const elementController = new ElementInteractionController({
		depsRef: elementDepsRef,
	});

	const resizeConfigRef = {
		get current() {
			const config = input.getConfig();
			return {
				zoomLevel: config.getZoomLevel(),
				snappingEnabled: config.isSnappingEnabled(),
				isShiftHeld: () => config.isShiftHeld(),
				getSceneTracks: () => toUpstreamTracks(config.getTracks()),
				getCurrentPlayheadTime: () =>
					mediaTime({ ticks: config.getCurrentPlayheadTime() }),
				getActiveProjectFps: () => config.getActiveProjectFps(),
				selectedElements: [...config.getSelectedElements()],
				discardPreview: () => config.discardResizePreview(),
				previewElements: (updates: GroupResizeUpdate[]) =>
					config.previewResizeElements(toHostResizeUpdates(updates)),
				commitElements: (updates: GroupResizeUpdate[]) =>
					config.commitResizeElements(toHostResizeUpdates(updates)),
				onSnapPointChange: (snapPoint: SnapPoint | null) =>
					config.onSnapPointChange?.(toHostSnapPoint(snapPoint)),
			};
		},
	};
	const resizeController = new ResizeController({
		configRef: resizeConfigRef,
	});

	const listeners = new Set<(
		snapshot: OpenCutElementInteractionSnapshot,
	) => void>();
	const readSnapshot = (): OpenCutElementInteractionSnapshot => ({
		dragView: toHostDragView(elementController.view),
		elementInteractionActive: elementController.isActive,
		isResizing: resizeController.isResizing,
	});
	let snapshot = readSnapshot();
	const refresh = () => {
		snapshot = readSnapshot();
		for (const listener of listeners) listener(snapshot);
	};
	const unsubscribeElement = elementController.subscribe(refresh);
	const unsubscribeResize = resizeController.subscribe(refresh);

	const withElement = (
		ref: EditorElementRef,
		callback: (resolved: {
			track: TimelineTrack;
			element: TimelineElement;
		}) => void,
	) => {
		const resolved = findTrackAndElement(
			toUpstreamTracks(input.getConfig().getTracks()),
			ref,
		);
		if (resolved) callback(resolved);
	};

	return {
		provenance: {
			project: "OpenCut-Classic",
			commit: OPEN_CUT_CLASSIC_COMMIT,
		},
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onElementMouseDown: ({ event, trackId, elementId }) =>
			withElement({ trackId, elementId }, ({ element, track }) =>
				elementController.onElementMouseDown({ event, element, track }),
			),
		onElementClick: ({ event, trackId, elementId }) =>
			withElement({ trackId, elementId }, ({ element, track }) =>
				elementController.onElementClick({ event, element, track }),
			),
		onResizeStart: ({ event, trackId, elementId, side }) =>
			withElement({ trackId, elementId }, ({ element, track }) =>
				resizeController.onResizeStart({
					event,
					element,
					track,
					side: side as ResizeSide,
				}),
			),
		cancelElementInteraction: elementController.cancel,
		cancelResize: () => resizeController.cancel(),
		destroy: () => {
			elementController.destroy();
			resizeController.destroy();
			unsubscribeElement();
			unsubscribeResize();
			listeners.clear();
		},
	};
}

/** Exact OpenCut layout helper; validates the integer media-time boundary. */
export function openCutTimelineTimeToPixels(input: {
	time: TimelineTicks;
	zoomLevel: number;
}): number {
	return timelineTimeToPixels({
		time: mediaTime({ ticks: input.time }),
		zoomLevel: input.zoomLevel,
	});
}

/** Exact OpenCut layout helper; Manju must not duplicate the base px/s. */
export function getOpenCutTimelinePixelsPerSecond(input: {
	zoomLevel: number;
}): number {
	return getTimelinePixelsPerSecond(input);
}

/** Exact OpenCut per-track vertical geometry used by drop hit testing. */
export function getOpenCutTrackHeight(input: {
	trackType: EditorTrackType;
}): number {
	return getTrackHeight({ type: input.trackType });
}

/** Exact OpenCut fit-to-container minimum zoom policy. */
export function getOpenCutTimelineZoomMin(input: {
	duration: TimelineTicks;
	containerWidth: number | null | undefined;
}): number {
	return getTimelineZoomMin({
		duration: mediaTime({ ticks: input.duration }),
		containerWidth: input.containerWidth,
	});
}

/**
 * Exact pinned content-width + zoom padding + viewport floor composition.
 */
export function getOpenCutTimelineLayout(input: {
	duration: TimelineTicks;
	containerWidth: number;
	zoomLevel: number;
}): {
	minZoom: number;
	contentWidth: number;
	paddingPx: number;
	dynamicTimelineWidth: number;
} {
	const duration = mediaTime({ ticks: input.duration });
	const minZoom = getTimelineZoomMin({
		duration,
		containerWidth: input.containerWidth,
	});
	return {
		minZoom,
		...getTimelineLayoutDimensions({
			duration,
			zoomLevel: input.zoomLevel,
			containerWidth: input.containerWidth,
			minZoom,
		}),
	};
}

/** Exact OpenCut exponential range-position to zoom transform. */
export function openCutSliderToZoom(input: {
	sliderPosition: number;
	minZoom: number;
	maxZoom?: number;
}): number {
	return sliderToZoom(input);
}

/** Exact OpenCut zoom to linear range-position transform. */
export function openCutZoomToSlider(input: {
	zoomLevel: number;
	minZoom: number;
	maxZoom?: number;
}): number {
	return zoomToSlider(input);
}
