import assert from "node:assert/strict";
import test from "node:test";
import {
	createOpenCutCommandEditor,
	createOpenCutElementInteractions,
	getOpenCutTimelineLayout,
	getOpenCutTimelinePixelsPerSecond,
	getOpenCutTimelineZoomMin,
	getOpenCutTrackHeight,
	OPEN_CUT_TIMELINE_LAYOUT_METRICS,
	openCutSliderToZoom,
	openCutTimelineTimeToPixels,
	openCutZoomToSlider,
} from "./index.js";
import type {
	EditorElementRef,
	EditorSceneTracks,
	EditorTimelineElement,
	ElementUpdateEntry,
} from "./contracts.js";
import type {
	OpenCutElementInteractionConfig,
	OpenCutElementMouseEvent,
} from "./opencut-element-interactions.js";

const SECOND = 120_000;

function element(input: {
	id: string;
	type?: EditorTimelineElement["type"];
	startTime: number;
	duration: number;
	trimStart?: number;
	trimEnd?: number;
	sourceDuration?: number;
	animations?: Record<string, unknown>;
}): EditorTimelineElement {
	return {
		id: input.id,
		name: input.id,
		type: input.type ?? "image",
		startTime: input.startTime,
		duration: input.duration,
		trimStart: input.trimStart ?? 0,
		trimEnd: input.trimEnd ?? 0,
		...(input.sourceDuration === undefined
			? {}
			: { sourceDuration: input.sourceDuration }),
		...(input.animations === undefined
			? {}
			: { animations: input.animations }),
		params: {},
	};
}

function sceneTracks(): EditorSceneTracks {
	return {
		overlay: [],
		main: { id: "main", type: "video", elements: [] },
		audio: [],
	};
}

function findElement(
	tracks: EditorSceneTracks,
	trackId: string,
	elementId: string,
): EditorTimelineElement | undefined {
	return [...tracks.overlay, tracks.main, ...tracks.audio]
		.find((track) => track.id === trackId)
		?.elements.find((candidate) => candidate.id === elementId);
}

function fakeElement(input: {
	left?: number;
	top?: number;
	height?: number;
	scrollLeft?: number;
	scrollTop?: number;
} = {}): HTMLDivElement {
	return {
		scrollLeft: input.scrollLeft ?? 0,
		scrollTop: input.scrollTop ?? 0,
		getBoundingClientRect: () => ({
			left: input.left ?? 0,
			top: input.top ?? 0,
			height: input.height ?? 0,
		}),
	} as unknown as HTMLDivElement;
}

function mouseEvent(input: {
	clientX?: number;
	clientY?: number;
	button?: number;
	metaKey?: boolean;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	currentTarget?: HTMLElement;
} = {}) {
	let stops = 0;
	let prevents = 0;
	const event: OpenCutElementMouseEvent = {
		button: input.button ?? 0,
		clientX: input.clientX ?? 0,
		clientY: input.clientY ?? 0,
		timeStamp: 0,
		target: {} as EventTarget,
		metaKey: input.metaKey ?? false,
		ctrlKey: input.ctrlKey ?? false,
		shiftKey: input.shiftKey ?? false,
		currentTarget: input.currentTarget ?? fakeElement(),
		stopPropagation: () => {
			stops += 1;
		},
		preventDefault: () => {
			prevents += 1;
		},
	};
	return {
		event,
		get stops() {
			return stops;
		},
		get prevents() {
			return prevents;
		},
	};
}

function installMouseDocument() {
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const listeners = new Map<string, Set<(event: MouseEvent) => void>>();
	const fakeDocument = {
		addEventListener(type: string, listener: (event: MouseEvent) => void) {
			const values = listeners.get(type) ?? new Set();
			values.add(listener);
			listeners.set(type, values);
		},
		removeEventListener(type: string, listener: (event: MouseEvent) => void) {
			listeners.get(type)?.delete(listener);
		},
	};
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: fakeDocument,
	});
	return {
		dispatch(type: "mousemove" | "mouseup", event: { clientX: number; clientY: number }) {
			for (const listener of [...(listeners.get(type) ?? [])]) {
				listener(event as MouseEvent);
			}
		},
		listenerCount(type: string) {
			return listeners.get(type)?.size ?? 0;
		},
		restore() {
			if (originalDocument) {
				Object.defineProperty(globalThis, "document", originalDocument);
			} else {
				Reflect.deleteProperty(globalThis, "document");
			}
		},
	};
}

function interactionFixture(input: {
	tracks: EditorSceneTracks;
	selected: EditorElementRef[];
	snappingEnabled?: boolean;
	playheadTime?: number;
}) {
	const editor = createOpenCutCommandEditor({ tracks: input.tracks });
	let selected = [...input.selected];
	let shiftHeld = false;
	const selectionClicks: Array<EditorElementRef & { isMultiKey: boolean }> = [];
	const snapPoints: Array<{ type: string } | null> = [];
	const moveCommits: unknown[] = [];
	const previews: ElementUpdateEntry[][] = [];
	const resizeCommits: ElementUpdateEntry[][] = [];
	let discardCount = 0;
	let clearKeyframeCount = 0;
	const tracksScroll = fakeElement();
	const tracksContainer = fakeElement();
	const header = fakeElement({ height: 0 });

	const config: OpenCutElementInteractionConfig = {
		getZoomLevel: () => 1,
		getTracksScrollEl: () => tracksScroll,
		getTracksContainerEl: () => tracksContainer,
		getHeaderEl: () => header,
		getTracks: () => editor.getTracks(),
		getActiveProjectFps: () => ({ numerator: 24, denominator: 1 }),
		isShiftHeld: () => shiftHeld,
		getSelectedElements: () => selected,
		isElementSelected: (ref) =>
			selected.some(
				(candidate) =>
					candidate.trackId === ref.trackId &&
					candidate.elementId === ref.elementId,
			),
		selectElement: (ref) => {
			selected = [{ ...ref }];
		},
		handleElementClick: (ref) => {
			selectionClicks.push({ ...ref });
			selected = ref.isMultiKey ? [...selected, { ...ref }] : [{ ...ref }];
		},
		clearKeyframeSelection: () => {
			clearKeyframeCount += 1;
		},
		getCurrentPlayheadTime: () => input.playheadTime ?? 10 * SECOND,
		isSnappingEnabled: () => input.snappingEnabled ?? false,
		onSnapPointChange: (point) => snapPoints.push(point),
		commitElementMoves: (commit) => {
			moveCommits.push(structuredClone(commit));
			editor.commitElementMoves(commit);
		},
		discardResizePreview: () => {
			discardCount += 1;
		},
		previewResizeElements: (updates) => {
			previews.push(structuredClone(updates));
		},
		commitResizeElements: (updates) => {
			resizeCommits.push(structuredClone(updates));
			editor.commitElementUpdates({ updates });
		},
	};
	const interactions = createOpenCutElementInteractions({
		getConfig: () => config,
	});

	return {
		editor,
		interactions,
		selectionClicks,
		snapPoints,
		moveCommits,
		previews,
		resizeCommits,
		get discardCount() {
			return discardCount;
		},
		get clearKeyframeCount() {
			return clearKeyframeCount;
		},
		setShiftHeld(value: boolean) {
			shiftHeld = value;
		},
	};
}

test("runs the pinned >5 px element drag through the atomic command editor and undo/redo", () => {
	const documentHarness = installMouseDocument();
	try {
		const tracks = sceneTracks();
		tracks.overlay = [
			{
				id: "video-a",
				type: "video",
				elements: [element({ id: "clip", startTime: 0, duration: SECOND })],
			},
			{ id: "video-b", type: "video", elements: [] },
		];
		const fixture = interactionFixture({
			tracks,
			selected: [{ trackId: "video-a", elementId: "clip" }],
		});
		const start = mouseEvent({
			clientX: 10,
			clientY: 10,
			currentTarget: fakeElement({ left: 0 }),
		});

		fixture.interactions.onElementMouseDown({
			event: start.event,
			trackId: "video-a",
			elementId: "clip",
		});
		assert.equal(start.stops, 1);
		assert.equal(fixture.interactions.getSnapshot().elementInteractionActive, true);
		assert.equal(documentHarness.listenerCount("mousemove"), 1);

		documentHarness.dispatch("mousemove", { clientX: 15, clientY: 15 });
		assert.equal(
			fixture.interactions.getSnapshot().dragView.kind,
			"idle",
			"the pinned controller requires movement strictly greater than 5 px",
		);

		documentHarness.dispatch("mousemove", { clientX: 110, clientY: 80 });
		const dragView = fixture.interactions.getSnapshot().dragView;
		assert.equal(dragView.kind, "dragging");
		assert.equal(dragView.kind === "dragging" ? dragView.currentTime : -1, 2 * SECOND);
		assert.equal(
			dragView.kind === "dragging"
				? dragView.memberTimeOffsets.get("clip")
				: undefined,
			0,
		);

		documentHarness.dispatch("mouseup", { clientX: 110, clientY: 80 });
		assert.equal(fixture.interactions.getSnapshot().dragView.kind, "idle");
		assert.equal(fixture.moveCommits.length, 1);
		assert.equal(findElement(fixture.editor.getTracks(), "video-a", "clip"), undefined);
		assert.equal(
			findElement(fixture.editor.getTracks(), "video-b", "clip")?.startTime,
			2 * SECOND,
		);

		fixture.editor.undo();
		assert.equal(findElement(fixture.editor.getTracks(), "video-a", "clip")?.startTime, 0);
		fixture.editor.redo();
		assert.equal(
			findElement(fixture.editor.getTracks(), "video-b", "clip")?.startTime,
			2 * SECOND,
		);

		const clickAfterDrag = mouseEvent();
		fixture.interactions.onElementClick({
			event: clickAfterDrag.event,
			trackId: "video-b",
			elementId: "clip",
		});
		assert.equal(fixture.clearKeyframeCount, 0, "post-drag click is swallowed");
		fixture.interactions.destroy();
	} finally {
		documentHarness.restore();
	}
});

test("preserves right-click selection without stopping context-menu bubbling", () => {
	const documentHarness = installMouseDocument();
	try {
		const tracks = sceneTracks();
		tracks.overlay = [
			{
				id: "video",
				type: "video",
				elements: [element({ id: "clip", startTime: 0, duration: SECOND })],
			},
		];
		const fixture = interactionFixture({ tracks, selected: [] });
		const rightClick = mouseEvent({ button: 2 });
		fixture.interactions.onElementMouseDown({
			event: rightClick.event,
			trackId: "video",
			elementId: "clip",
		});
		assert.equal(rightClick.stops, 0);
		assert.deepEqual(fixture.selectionClicks, [
			{ trackId: "video", elementId: "clip", isMultiKey: false },
		]);
		assert.equal(documentHarness.listenerCount("mousemove"), 0);
		fixture.interactions.destroy();
	} finally {
		documentHarness.restore();
	}
});

test("snaps moving group edges through the pinned element/playhead/keyframe source pipeline", () => {
	const documentHarness = installMouseDocument();
	try {
		const tracks = sceneTracks();
		tracks.overlay = [
			{
				id: "source",
				type: "video",
				elements: [element({ id: "moving", startTime: 0, duration: SECOND })],
			},
			{ id: "target", type: "video", elements: [] },
		];
		tracks.main.elements = [
			element({ id: "stationary", startTime: 3 * SECOND, duration: SECOND }),
		];
		const fixture = interactionFixture({
			tracks,
			selected: [{ trackId: "source", elementId: "moving" }],
			snappingEnabled: true,
		});
		fixture.interactions.onElementMouseDown({
			event: mouseEvent({ clientX: 0, clientY: 10 }).event,
			trackId: "source",
			elementId: "moving",
		});
		documentHarness.dispatch("mousemove", { clientX: 98, clientY: 80 });
		const view = fixture.interactions.getSnapshot().dragView;
		assert.equal(view.kind, "dragging");
		assert.equal(view.kind === "dragging" ? view.currentTime : -1, 2 * SECOND);
		assert.equal(fixture.snapPoints.at(-1)?.type, "element-start");

		fixture.interactions.cancelElementInteraction();
		assert.equal(fixture.snapPoints.at(-1), null);
		assert.equal(fixture.moveCommits.length, 0);
		fixture.interactions.destroy();
	} finally {
		documentHarness.restore();
	}
});

test("runs resize preview and atomic UpdateElementsCommand commit with undo/redo", () => {
	const documentHarness = installMouseDocument();
	try {
		const tracks = sceneTracks();
		tracks.overlay = [
			{
				id: "video",
				type: "video",
				elements: [
					element({
						id: "clip",
						type: "video",
						startTime: 0,
						duration: SECOND,
						trimEnd: SECOND,
						sourceDuration: 2 * SECOND,
					}),
				],
			},
		];
		const fixture = interactionFixture({
			tracks,
			selected: [{ trackId: "video", elementId: "clip" }],
		});
		const start = mouseEvent({ clientX: 0 });
		fixture.interactions.onResizeStart({
			event: start.event,
			trackId: "video",
			elementId: "clip",
			side: "right",
		});
		assert.equal(start.stops, 1);
		assert.equal(start.prevents, 1);
		assert.equal(fixture.discardCount, 1);
		assert.equal(fixture.interactions.getSnapshot().isResizing, true);

		documentHarness.dispatch("mousemove", { clientX: 50, clientY: 0 });
		assert.deepEqual(fixture.previews.at(-1), [
			{
				trackId: "video",
				elementId: "clip",
				patch: {
					trimStart: 0,
					trimEnd: 0,
					startTime: 0,
					duration: 2 * SECOND,
				},
			},
		]);

		documentHarness.dispatch("mouseup", { clientX: 50, clientY: 0 });
		assert.equal(fixture.discardCount, 2);
		assert.equal(fixture.resizeCommits.length, 1);
		assert.equal(fixture.interactions.getSnapshot().isResizing, false);
		assert.equal(
			findElement(fixture.editor.getTracks(), "video", "clip")?.duration,
			2 * SECOND,
		);
		fixture.editor.undo();
		assert.equal(
			findElement(fixture.editor.getTracks(), "video", "clip")?.duration,
			SECOND,
		);
		fixture.editor.redo();
		assert.equal(
			findElement(fixture.editor.getTracks(), "video", "clip")?.duration,
			2 * SECOND,
		);
		fixture.interactions.destroy();
	} finally {
		documentHarness.restore();
	}
});

test("includes pinned animation-keyframe snap sources and shift bypass", () => {
	const documentHarness = installMouseDocument();
	try {
		const tracks = sceneTracks();
		tracks.overlay = [
			{
				id: "moving",
				type: "video",
				elements: [element({ id: "clip", startTime: 0, duration: SECOND })],
			},
		];
		tracks.main.elements = [
			element({
				id: "animated",
				startTime: 2 * SECOND,
				duration: SECOND,
				animations: {
					opacity: {
						keys: [
							{
								id: "opacity-key",
								time: SECOND / 2,
								value: 0.5,
								segmentToNext: "linear",
								tangentMode: "flat",
							},
						],
					},
				},
			}),
		];
		const fixture = interactionFixture({
			tracks,
			selected: [{ trackId: "moving", elementId: "clip" }],
			snappingEnabled: true,
		});

		fixture.interactions.onResizeStart({
			event: mouseEvent({ clientX: 0 }).event,
			trackId: "moving",
			elementId: "clip",
			side: "right",
		});
		documentHarness.dispatch("mousemove", { clientX: 72.5, clientY: 0 });
		assert.equal(fixture.snapPoints.at(-1)?.type, "keyframe");
		assert.equal(fixture.previews.at(-1)?.[0]?.patch.duration, 2.5 * SECOND);
		fixture.interactions.cancelResize();
		assert.equal(fixture.snapPoints.at(-1), null);
		assert.equal(fixture.resizeCommits.length, 0);

		fixture.setShiftHeld(true);
		fixture.interactions.onResizeStart({
			event: mouseEvent({ clientX: 0 }).event,
			trackId: "moving",
			elementId: "clip",
			side: "right",
		});
		documentHarness.dispatch("mousemove", { clientX: 72.5, clientY: 0 });
		assert.equal(fixture.snapPoints.at(-1), null);
		assert.equal(
			fixture.previews.at(-1)?.[0]?.patch.duration,
			295_000,
			"shift bypasses edge snapping but resize still uses OpenCut frame rounding",
		);
		fixture.interactions.cancelResize();
		fixture.interactions.destroy();
	} finally {
		documentHarness.restore();
	}
});

test("exposes the pinned horizontal and vertical OpenCut layout contract", () => {
	assert.equal(getOpenCutTimelinePixelsPerSecond({ zoomLevel: 2 }), 100);
	assert.equal(
		openCutTimelineTimeToPixels({ time: 3 * SECOND, zoomLevel: 2 }),
		300,
	);
	assert.equal(
		getOpenCutTimelineZoomMin({ duration: 10 * SECOND, containerWidth: 1_000 }),
		0.5,
	);
	const layout = getOpenCutTimelineLayout({
		duration: 10 * SECOND,
		containerWidth: 1_000,
		zoomLevel: 1,
	});
	assert.equal(layout.minZoom, 0.5);
	assert.equal(layout.contentWidth, 500);
	assert.ok(layout.paddingPx > 700 && layout.paddingPx < 750);
	assert.equal(layout.dynamicTimelineWidth, layout.contentWidth + layout.paddingPx);

	assert.equal(getOpenCutTrackHeight({ trackType: "video" }), 65);
	assert.equal(getOpenCutTrackHeight({ trackType: "audio" }), 50);
	assert.equal(getOpenCutTrackHeight({ trackType: "text" }), 25);
	assert.deepEqual(OPEN_CUT_TIMELINE_LAYOUT_METRICS, {
		zoomMax: 100,
		trackGapPx: 6,
		trackLabelsColumnWidthPx: 112,
		rulerHeightPx: 22,
		bookmarkRowHeightPx: 16,
		scrollbarSizePx: 12,
		contentTopPaddingPx: 2,
	});
	assert.equal(openCutSliderToZoom({ sliderPosition: 0, minZoom: 0.5 }), 0.5);
	assert.equal(openCutSliderToZoom({ sliderPosition: 1, minZoom: 0.5 }), 100);
	assert.ok(
		Math.abs(
			openCutZoomToSlider({
				zoomLevel: openCutSliderToZoom({
					sliderPosition: 0.37,
					minZoom: 0.5,
				}),
				minZoom: 0.5,
			}) - 0.37,
		) < 1e-12,
	);
	assert.throws(
		() => openCutTimelineTimeToPixels({ time: 1.5, zoomLevel: 1 }),
		/MediaTime must be a safe integer tick count/,
	);
});
