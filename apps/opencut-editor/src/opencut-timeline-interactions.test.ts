import assert from "node:assert/strict";
import test from "node:test";
import {
	createOpenCutTimelineInteractions,
	OPEN_CUT_CLASSIC_COMMIT,
} from "./index.js";
import type {
	OpenCutTimelineInteractionConfig,
	OpenCutTimelineMouseEvent,
	OpenCutTimelineViewState,
	OpenCutTimelineWheelEvent,
} from "./contracts.js";

const SECOND = 120_000;

interface FakeScrollOptions {
	left?: number;
	scrollLeft?: number;
	scrollWidth?: number;
	clientWidth?: number;
	contains?: EventTarget[];
}

function fakeScrollElement(options: FakeScrollOptions = {}): HTMLDivElement {
	const containedTargets = new Set(options.contains ?? []);
	return {
		scrollLeft: options.scrollLeft ?? 0,
		scrollWidth: options.scrollWidth ?? 2_000,
		clientWidth: options.clientWidth ?? 500,
		contains: (target: Node | null) =>
			target !== null && containedTargets.has(target as EventTarget),
		getBoundingClientRect: () => ({ left: options.left ?? 0 }),
	} as unknown as HTMLDivElement;
}

function mouseEvent(
	overrides: Partial<OpenCutTimelineMouseEvent> = {},
): OpenCutTimelineMouseEvent {
	return {
		button: 0,
		clientX: 0,
		clientY: 0,
		timeStamp: 0,
		target: {} as EventTarget,
		...overrides,
	};
}

function wheelEvent(
	overrides: Partial<OpenCutTimelineWheelEvent> = {},
): OpenCutTimelineWheelEvent {
	return {
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		deltaX: 0,
		deltaY: 0,
		deltaMode: 0,
		...overrides,
	};
}

function interactionFixture(options: {
	initialZoom?: number;
	minZoom?: number;
	duration?: number;
	playheadTime?: number;
	tracks?: HTMLDivElement;
	ruler?: HTMLDivElement;
	playhead?: HTMLDivElement | null;
	labels?: HTMLDivElement | null;
	container?: HTMLDivElement | null;
	fps?: { numerator: number; denominator: number } | null;
} = {}) {
	const seeks: number[] = [];
	const views: OpenCutTimelineViewState[] = [];
	let clearCount = 0;
	let selecting = false;
	let playheadTime = options.playheadTime ?? SECOND;
	const tracks = options.tracks ?? fakeScrollElement();
	const ruler = options.ruler ?? fakeScrollElement();
	const config: OpenCutTimelineInteractionConfig = {
		minZoom: options.minZoom ?? 1,
		duration: options.duration ?? 10 * SECOND,
		isSelecting: selecting,
		getContainerEl: () => options.container ?? tracks,
		getPlayheadEl: () => options.playhead ?? null,
		getTrackLabelsEl: () => options.labels ?? null,
		getRulerScrollEl: () => ruler,
		getTracksScrollEl: () => tracks,
		getActiveProjectFps: () =>
			options.fps === undefined
				? { numerator: 24, denominator: 1 }
				: options.fps,
		getCurrentPlayheadTime: () => playheadTime,
		clearSelectedElements: () => {
			clearCount += 1;
		},
		seek: (time) => {
			playheadTime = time;
			seeks.push(time);
		},
		setTimelineViewState: (viewState) => views.push(viewState),
	};
	const interactions = createOpenCutTimelineInteractions({
		getConfig: () => ({ ...config, isSelecting: selecting }),
		initialZoom: options.initialZoom,
	});

	return {
		interactions,
		seeks,
		views,
		tracks,
		ruler,
		get clearCount() {
			return clearCount;
		},
		setSelecting(value: boolean) {
			selecting = value;
		},
	};
}

test("reports pinned provenance and delegates OpenCut's inclusive click gesture and px-to-time math", () => {
	const tracks = fakeScrollElement({ left: 100, scrollLeft: 25 });
	const fixture = interactionFixture({ initialZoom: 2, tracks });

	assert.deepEqual(fixture.interactions.provenance, {
		project: "OpenCut-Classic",
		commit: OPEN_CUT_CLASSIC_COMMIT,
	});
	fixture.interactions.onTracksMouseDown(
		mouseEvent({ clientX: 120, clientY: 20, timeStamp: 100 }),
	);
	fixture.interactions.onTracksClick(
		mouseEvent({ clientX: 125, clientY: 25, timeStamp: 600 }),
	);

	assert.equal(fixture.clearCount, 1, "5 px / 500 ms is an OpenCut click");
	assert.deepEqual(fixture.seeks, [60_000]);
	assert.deepEqual(fixture.views, [
		{ zoomLevel: 2, scrollLeft: 25, playheadTime: 60_000 },
	]);
});

test("preserves OpenCut seek guards for drag distance, source, selection, playhead, and labels", () => {
	const playheadTarget = {} as EventTarget;
	const labelTarget = {} as EventTarget;
	const fixture = interactionFixture({
		playhead: fakeScrollElement({ contains: [playheadTarget] }),
		labels: fakeScrollElement({ contains: [labelTarget] }),
	});

	fixture.interactions.onTracksMouseDown(
		mouseEvent({ clientX: 10, clientY: 10, timeStamp: 0 }),
	);
	fixture.interactions.onTracksClick(
		mouseEvent({ clientX: 16, clientY: 10, timeStamp: 1 }),
	);

	fixture.interactions.onTracksMouseDown(mouseEvent());
	fixture.interactions.onRulerClick(mouseEvent());

	fixture.setSelecting(true);
	fixture.interactions.onTracksMouseDown(mouseEvent());
	fixture.interactions.onTracksClick(mouseEvent());
	fixture.setSelecting(false);

	fixture.interactions.onTracksMouseDown(mouseEvent());
	fixture.interactions.onTracksClick(mouseEvent({ target: playheadTarget }));

	fixture.interactions.onTracksMouseDown(mouseEvent());
	fixture.interactions.onTracksClick(mouseEvent({ target: labelTarget }));

	assert.deepEqual(fixture.seeks, []);
	assert.equal(
		fixture.clearCount,
		1,
		"OpenCut clears a label click but does not seek",
	);
});

test("uses the ruler viewport, clamps to duration, and frame-snaps supported rates", () => {
	const ruler = fakeScrollElement({ left: 50, scrollLeft: 0 });
	const fixture = interactionFixture({
		initialZoom: 1,
		duration: SECOND,
		ruler,
	});

	fixture.interactions.onRulerMouseDown(
		mouseEvent({ clientX: 10_000, timeStamp: 10 }),
	);
	fixture.interactions.onRulerClick(
		mouseEvent({ clientX: 10_000, timeStamp: 11 }),
	);

	assert.deepEqual(fixture.seeks, [SECOND]);
	assert.deepEqual(fixture.views.at(-1), {
		zoomLevel: 1,
		scrollLeft: 0,
		playheadTime: SECOND,
	});
});

test("rounds non-aligned seek time to the nearest frame and preserves the WASM fallback for unsupported rates", () => {
	const supported = interactionFixture({ initialZoom: 1 });
	supported.interactions.onTracksMouseDown(
		mouseEvent({ clientX: 12, timeStamp: 1 }),
	);
	supported.interactions.onTracksClick(
		mouseEvent({ clientX: 12, timeStamp: 2 }),
	);
	assert.deepEqual(supported.seeks, [30_000]);

	const unsupported = interactionFixture({
		initialZoom: 1,
		fps: { numerator: 7, denominator: 3 },
	});
	unsupported.interactions.onTracksMouseDown(
		mouseEvent({ clientX: 12, timeStamp: 1 }),
	);
	unsupported.interactions.onTracksClick(
		mouseEvent({ clientX: 12, timeStamp: 2 }),
	);
	assert.deepEqual(unsupported.seeks, [28_800]);
});

test("rejects fractional MediaTime values at the facade boundary", () => {
	const fixture = interactionFixture({ duration: SECOND + 0.5 });
	fixture.interactions.onTracksMouseDown(mouseEvent());
	assert.throws(
		() => fixture.interactions.onTracksClick(mouseEvent()),
		/MediaTime must be a safe integer tick count/,
	);
});

test("preserves OpenCut wheel classification, delta cap, zoom clamp, and notifications", () => {
	const fixture = interactionFixture({ initialZoom: 1, minZoom: 1 });
	let notifications = 0;
	const unsubscribe = fixture.interactions.subscribeZoom(() => {
		notifications += 1;
	});

	fixture.interactions.onWheel(
		wheelEvent({ ctrlKey: true, deltaX: 20, deltaY: 10 }),
	);
	assert.equal(fixture.interactions.zoomLevel, 1, "horizontal wheel is ignored");

	fixture.interactions.onWheel(
		wheelEvent({ ctrlKey: true, shiftKey: true, deltaY: -20 }),
	);
	assert.equal(fixture.interactions.zoomLevel, 1, "shift wheel is ignored");

	fixture.interactions.onWheel(
		wheelEvent({ ctrlKey: true, deltaY: -100, deltaMode: 1 }),
	);
	assert.ok(
		Math.abs(fixture.interactions.zoomLevel - Math.exp(0.1)) < 1e-12,
		"line deltas are normalized and capped at 30 before exponential zoom",
	);

	fixture.interactions.setZoomLevel(1_000);
	assert.equal(fixture.interactions.zoomLevel, 100);
	fixture.interactions.setZoomLevel(-1);
	assert.equal(fixture.interactions.zoomLevel, 1);
	assert.equal(notifications, 3);

	unsubscribe();
	fixture.interactions.setZoomLevel(2);
	assert.equal(notifications, 3);
});

test("preserves OpenCut's playhead-anchor threshold when applying zoom layout", () => {
	const tracks = fakeScrollElement({
		scrollLeft: 100,
		scrollWidth: 2_000,
		clientWidth: 500,
	});
	const ruler = fakeScrollElement({ scrollLeft: 100 });
	const fixture = interactionFixture({
		initialZoom: 1,
		minZoom: 1,
		playheadTime: 2 * SECOND,
		tracks,
		ruler,
	});

	fixture.interactions.setZoomLevel(4);
	fixture.interactions.applyZoomLayout();
	assert.equal(tracks.scrollLeft, 400);
	assert.equal(ruler.scrollLeft, 400);

	fixture.interactions.setZoomLevel(1);
	fixture.interactions.applyZoomLayout();
	assert.equal(tracks.scrollLeft, 100);
	assert.equal(ruler.scrollLeft, 100);
	assert.deepEqual(fixture.views, [
		{ zoomLevel: 4, scrollLeft: 400, playheadTime: 2 * SECOND },
		{ zoomLevel: 1, scrollLeft: 100, playheadTime: 2 * SECOND },
	]);
});

test("restores persisted scroll/playhead once and debounces scroll persistence", async () => {
	const tracks = fakeScrollElement({ scrollLeft: 0, scrollWidth: 1_000 });
	const ruler = fakeScrollElement({ scrollLeft: 0 });
	const fixture = interactionFixture({ tracks, ruler, initialZoom: 2 });

	fixture.interactions.restoreInitialScrollIfNeeded(240);
	fixture.interactions.restoreInitialScrollIfNeeded(480);
	assert.equal(tracks.scrollLeft, 240);
	assert.equal(ruler.scrollLeft, 240);

	fixture.interactions.restoreInitialPlayheadIfNeeded(3 * SECOND);
	fixture.interactions.restoreInitialPlayheadIfNeeded(4 * SECOND);
	assert.deepEqual(fixture.seeks, [3 * SECOND]);

	tracks.scrollLeft = 360;
	fixture.interactions.saveScrollPosition();
	tracks.scrollLeft = 420;
	fixture.interactions.saveScrollPosition();
	await new Promise((resolve) => setTimeout(resolve, 340));
	assert.deepEqual(fixture.views.at(-1), {
		zoomLevel: 2,
		scrollLeft: 420,
		playheadTime: 3 * SECOND,
	});
});

test("binds and removes OpenCut's capture listener that prevents browser zoom only inside the container", () => {
	const inside = {} as EventTarget;
	const outside = {} as EventTarget;
	const container = fakeScrollElement({ contains: [inside] });
	const fixture = interactionFixture({ container });
	const originalDocument = globalThis.document;
	let listener: ((event: WheelEvent) => void) | undefined;
	let removeCapture: boolean | undefined;
	const fakeDocument = {
		addEventListener: (
			type: string,
			callback: (event: WheelEvent) => void,
			options: AddEventListenerOptions,
		) => {
			assert.equal(type, "wheel");
			assert.deepEqual(options, { passive: false, capture: true });
			listener = callback;
		},
		removeEventListener: (
			type: string,
			_callback: (event: WheelEvent) => void,
			options: EventListenerOptions,
		) => {
			assert.equal(type, "wheel");
			removeCapture = options.capture;
		},
	};

	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: fakeDocument,
	});
	try {
		const unbind = fixture.interactions.bindPreventBrowserZoom();
		let prevented = 0;
		listener?.({
			ctrlKey: true,
			metaKey: false,
			target: inside,
			preventDefault: () => {
				prevented += 1;
			},
		} as unknown as WheelEvent);
		listener?.({
			ctrlKey: true,
			metaKey: false,
			target: outside,
			preventDefault: () => {
				prevented += 1;
			},
		} as unknown as WheelEvent);
		assert.equal(prevented, 1);
		unbind();
		assert.equal(removeCapture, true);
	} finally {
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: originalDocument,
		});
	}
});
