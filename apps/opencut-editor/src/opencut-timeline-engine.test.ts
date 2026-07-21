import assert from "node:assert/strict";
import test from "node:test";
import {
	createOpenCutTimelineEngine,
	OPEN_CUT_CLASSIC_COMMIT,
} from "./index.js";
import type {
	EditorSceneTracks,
	EditorTimelineElement,
	TimelineSnapPoint,
} from "./contracts.js";

const SECOND = 120_000;

function element(
	id: string,
	type: EditorTimelineElement["type"],
	startTime: number,
	duration: number,
): EditorTimelineElement {
	return { id, type, startTime, duration };
}

function sceneTracks(): EditorSceneTracks {
	return {
		overlay: [],
		main: { id: "main", type: "video", elements: [] },
		audio: [],
	};
}

test("reports the exact pinned OpenCut Classic implementation", () => {
	const engine = createOpenCutTimelineEngine();
	assert.deepEqual(engine.provenance, {
		project: "OpenCut-Classic",
		commit: OPEN_CUT_CLASSIC_COMMIT,
	});
	assert.equal(
		OPEN_CUT_CLASSIC_COMMIT,
		"cf5e79e919144200294fb9fed22a222592a0aeea",
	);
});

test("aggregates OpenCut snap sources and chooses the closest point", () => {
	const engine = createOpenCutTimelineEngine();
	const clipEdges: TimelineSnapPoint[] = [
		{ time: SECOND, type: "element-end", elementId: "clip-1" },
	];
	const playhead: TimelineSnapPoint[] = [
		{ time: 145_000, type: "playhead" },
	];

	const result = engine.resolveSnap({
		targetTime: 122_000,
		zoomLevel: 1,
		sources: [
			{ getSnapPoints: () => clipEdges },
			{ getSnapPoints: () => playhead },
		],
	});

	// At zoom 1 OpenCut's 10 px threshold is 24,000 ticks. Both points
	// qualify, and the 2,000-tick clip edge wins over the 23,000-tick playhead.
	assert.deepEqual(result, {
		snappedTime: SECOND,
		snapPoint: {
			time: SECOND,
			type: "element-end",
			elementId: "clip-1",
		},
		snapDistance: 2_000,
	});
});

test("returns an explicit no-snap result outside the OpenCut threshold", () => {
	const engine = createOpenCutTimelineEngine();
	assert.deepEqual(
		engine.resolveSnap({
			targetTime: 2 * SECOND,
			zoomLevel: 1,
			sources: [
				{
					getSnapPoints: () => [
						{ time: SECOND, type: "bookmark" as const },
					],
				},
			],
		}),
		{
			snappedTime: 2 * SECOND,
			snapPoint: null,
			snapDistance: null,
		},
	);
});

test("firstAvailable placement skips an overlapping track", () => {
	const engine = createOpenCutTimelineEngine();
	const tracks = sceneTracks();
	tracks.overlay = [
		{
			id: "subtitles-busy",
			type: "text",
			elements: [element("subtitle-1", "text", 0, 5 * SECOND)],
		},
		{ id: "subtitles-free", type: "text", elements: [] },
	];

	assert.deepEqual(
		engine.resolvePlacement({
			tracks,
			elementType: "text",
			timeSpans: [{ startTime: 2 * SECOND, duration: SECOND }],
			strategy: { type: "firstAvailable" },
		}),
		{
			kind: "existingTrack",
			trackId: "subtitles-free",
			trackIndex: 1,
			trackType: "text",
		},
	);
});

test("main-track placement keeps OpenCut's zero-start invariant", () => {
	const engine = createOpenCutTimelineEngine();
	assert.deepEqual(
		engine.resolvePlacement({
			tracks: sceneTracks(),
			elementType: "video",
			timeSpans: [{ startTime: 3 * SECOND, duration: SECOND }],
			strategy: { type: "explicit", trackId: "main" },
		}),
		{
			kind: "existingTrack",
			trackId: "main",
			trackIndex: 0,
			trackType: "video",
			adjustedStartTime: 0,
		},
	);
});

test("placement returns OpenCut's new-track decision when no track fits", () => {
	const engine = createOpenCutTimelineEngine();
	const tracks = sceneTracks();
	tracks.overlay = [
		{
			id: "subtitles-busy",
			type: "text",
			elements: [element("subtitle-1", "text", 0, 5 * SECOND)],
		},
	];

	assert.deepEqual(
		engine.resolvePlacement({
			tracks,
			elementType: "text",
			timeSpans: [{ startTime: SECOND, duration: SECOND }],
			strategy: { type: "firstAvailable" },
		}),
		{
			kind: "newTrack",
			insertIndex: 0,
			insertPosition: null,
			trackType: "text",
		},
	);
});

test("exposes OpenCut overlap and element/track compatibility semantics", () => {
	const engine = createOpenCutTimelineEngine();
	const clip = element("image-1", "image", 0, SECOND);

	assert.equal(
		engine.canPlace({
			track: { elements: [clip] },
			timeSpans: [{ startTime: SECOND, duration: SECOND }],
		}),
		true,
		"touching clip edges are not an overlap",
	);
	assert.equal(
		engine.canPlace({
			track: { elements: [clip] },
			timeSpans: [{ startTime: SECOND - 1, duration: SECOND }],
		}),
		false,
	);
	assert.equal(engine.getTrackTypeForElement("image"), "video");
	assert.equal(engine.isElementTrackCompatible("image", "video"), true);
	assert.equal(engine.isElementTrackCompatible("image", "graphic"), false);
});

test("rejects fractional tick input at the adapter boundary", () => {
	const engine = createOpenCutTimelineEngine();
	assert.throws(
		() =>
			engine.resolveSnap({
				targetTime: 1.5,
				zoomLevel: 1,
				sources: [],
			}),
		/MediaTime must be a safe integer tick count/,
	);
});
