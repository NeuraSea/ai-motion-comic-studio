import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCutCommandEditor } from "./index.js";
import type {
	EditorSceneTracks,
	EditorTimelineElement,
} from "./contracts.js";

const SECOND = 120_000;

function element({
	id,
	type = "image",
	startTime,
	duration,
	trimStart = 0,
	trimEnd = 0,
	sourceDuration,
}: {
	id: string;
	type?: EditorTimelineElement["type"];
	startTime: number;
	duration: number;
	trimStart?: number;
	trimEnd?: number;
	sourceDuration?: number;
}): EditorTimelineElement {
	return {
		id,
		type,
		name: id,
		startTime,
		duration,
		trimStart,
		trimEnd,
		...(sourceDuration === undefined ? {} : { sourceDuration }),
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
		?.elements.find((item) => item.id === elementId);
}

test("executes OpenCut group move and command undo/redo round trips", () => {
	const tracks = sceneTracks();
	tracks.overlay = [
		{
			id: "video-a",
			type: "video",
			elements: [
				element({ id: "clip", startTime: SECOND, duration: 2 * SECOND }),
			],
		},
		{ id: "video-b", type: "video", elements: [] },
	];
	const editor = createOpenCutCommandEditor({ tracks });
	const before = editor.getTracks();

	assert.deepEqual(
		editor.moveElements({
			anchor: { trackId: "video-a", elementId: "clip" },
			anchorStartTime: 4 * SECOND,
			targetTrackId: "video-b",
		}),
		{
			moves: [
				{
					sourceTrackId: "video-a",
					targetTrackId: "video-b",
					elementId: "clip",
					newStartTime: 4 * SECOND,
				},
			],
		},
	);
	const moved = editor.getTracks();
	assert.equal(findElement(moved, "video-a", "clip"), undefined);
	assert.equal(findElement(moved, "video-b", "clip")?.startTime, 4 * SECOND);
	assert.equal(editor.canUndo(), true);
	assert.equal(editor.canRedo(), false);

	editor.undo();
	assert.deepEqual(editor.getTracks(), before);
	assert.equal(editor.canRedo(), true);

	editor.redo();
	assert.deepEqual(editor.getTracks(), moved);
	editor.undo();
	assert.deepEqual(editor.getTracks(), before);
});

test("atomically commits controller-resolved moves, track creation, and updates through command history", () => {
	const tracks = sceneTracks();
	tracks.overlay = [
		{
			id: "source",
			type: "video",
			elements: [element({ id: "clip", startTime: 0, duration: SECOND })],
		},
	];
	const editor = createOpenCutCommandEditor({ tracks });
	const before = editor.getTracks();

	editor.commitElementMoves({
		moves: [
			{
				sourceTrackId: "source",
				targetTrackId: "created",
				elementId: "clip",
				newStartTime: 2 * SECOND,
			},
		],
		createTracks: [{ id: "created", type: "video", index: 1 }],
	});
	const moved = editor.getTracks();
	assert.equal(findElement(moved, "source", "clip"), undefined);
	assert.equal(findElement(moved, "created", "clip")?.startTime, 2 * SECOND);

	editor.commitElementUpdates({
		updates: [
			{
				trackId: "created",
				elementId: "clip",
				patch: {
					trimStart: 0,
					trimEnd: 0,
					startTime: 2 * SECOND,
					duration: 2 * SECOND,
				},
			},
		],
	});
	const updated = editor.getTracks();
	assert.equal(findElement(updated, "created", "clip")?.duration, 2 * SECOND);

	editor.undo();
	assert.deepEqual(editor.getTracks(), moved);
	editor.undo();
	assert.deepEqual(editor.getTracks(), before);
	editor.redo();
	assert.deepEqual(editor.getTracks(), moved);
	editor.redo();
	assert.deepEqual(editor.getTracks(), updated);
});

test("preserves canonical OpenCut union fields and required track metadata", () => {
	const tracks: EditorSceneTracks = {
		overlay: [
			{
				id: "visual-a",
				name: "画面 A",
				type: "video",
				hidden: false,
				muted: true,
				elements: [
					{
						id: "image",
						name: "镜头",
						type: "image",
						mediaId: "asset-image",
						startTime: 0,
						duration: SECOND,
						trimStart: 0,
						trimEnd: 0,
						params: { storyShotId: "shot-1" },
						masks: [{ id: "mask-1" }],
						manju: { bindingRevision: 2 },
					},
				],
			},
			{
				id: "visual-b",
				name: "画面 B",
				type: "video",
				hidden: true,
				muted: false,
				elements: [],
			},
		],
		main: {
			id: "main",
			name: "主轨",
			type: "video",
			hidden: false,
			muted: false,
			elements: [],
		},
		audio: [
			{
				id: "dialogue",
				name: "对白",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "audio",
						name: "台词",
						type: "audio",
						sourceType: "upload",
						mediaId: "asset-audio",
						startTime: 0,
						duration: SECOND,
						trimStart: 0,
						trimEnd: 0,
						params: { storyDialogueId: "dialogue-1" },
					},
				],
			},
		],
	};
	const editor = createOpenCutCommandEditor({ tracks });

	assert.deepEqual(editor.getTracks(), tracks);
	editor.moveElements({
		anchor: { trackId: "visual-a", elementId: "image" },
		anchorStartTime: 2 * SECOND,
		targetTrackId: "visual-b",
	});
	const moved = editor.getTracks();
	assert.equal(moved.overlay[0]?.name, "画面 A");
	assert.equal(moved.overlay[1]?.hidden, true);
	assert.equal(moved.main.name, "主轨");
	assert.equal(moved.audio[0]?.muted, false);
	assert.deepEqual(findElement(moved, "visual-b", "image"), {
		...tracks.overlay[0]!.elements[0],
		startTime: 2 * SECOND,
	});
	assert.equal(findElement(moved, "dialogue", "audio")?.sourceType, "upload");
	assert.equal(findElement(moved, "dialogue", "audio")?.mediaId, "asset-audio");

	editor.undo();
	assert.deepEqual(editor.getTracks(), tracks);
});

test("rejects a group move whose upstream placement check finds a collision", () => {
	const tracks = sceneTracks();
	tracks.overlay = [
		{
			id: "video-a",
			type: "video",
			elements: [element({ id: "moving", startTime: 0, duration: SECOND })],
		},
		{
			id: "video-b",
			type: "video",
			elements: [
				element({ id: "stationary", startTime: 2 * SECOND, duration: SECOND }),
			],
		},
	];
	const editor = createOpenCutCommandEditor({ tracks });
	const before = editor.getTracks();

	assert.equal(
		editor.moveElements({
			anchor: { trackId: "video-a", elementId: "moving" },
			anchorStartTime: 2 * SECOND + 1,
			targetTrackId: "video-b",
		}),
		null,
	);
	assert.deepEqual(editor.getTracks(), before);
	assert.equal(editor.canUndo(), false);
});

test("moves an OpenCut multi-track group while preserving member time offsets", () => {
	const tracks = sceneTracks();
	tracks.overlay = [
		{
			id: "source-a",
			type: "video",
			elements: [element({ id: "a", startTime: SECOND, duration: SECOND })],
		},
		{
			id: "source-b",
			type: "video",
			elements: [
				element({ id: "b", startTime: 2 * SECOND, duration: SECOND }),
			],
		},
		{ id: "target-a", type: "video", elements: [] },
		{ id: "target-b", type: "video", elements: [] },
	];
	const editor = createOpenCutCommandEditor({ tracks });

	const result = editor.moveElements({
		anchor: { trackId: "source-a", elementId: "a" },
		selectedElements: [
			{ trackId: "source-a", elementId: "a" },
			{ trackId: "source-b", elementId: "b" },
		],
		anchorStartTime: 5 * SECOND,
		targetTrackId: "target-a",
	});
	assert.deepEqual(result?.moves, [
		{
			sourceTrackId: "source-a",
			targetTrackId: "target-a",
			elementId: "a",
			newStartTime: 5 * SECOND,
		},
		{
			sourceTrackId: "source-b",
			targetTrackId: "target-b",
			elementId: "b",
			newStartTime: 6 * SECOND,
		},
	]);
	assert.equal(findElement(editor.getTracks(), "target-a", "a")?.startTime, 5 * SECOND);
	assert.equal(findElement(editor.getTracks(), "target-b", "b")?.startTime, 6 * SECOND);
});

test("uses OpenCut resize bounds, trim math, and update-command history", () => {
	const tracks = sceneTracks();
	tracks.overlay = [
		{
			id: "video",
			type: "video",
			elements: [
				element({
					id: "clip",
					startTime: 0,
					duration: SECOND,
					trimEnd: SECOND,
					sourceDuration: 2 * SECOND,
				}),
				element({
					id: "neighbor",
					startTime: SECOND + SECOND / 2,
					duration: SECOND,
				}),
			],
		},
	];
	const editor = createOpenCutCommandEditor({ tracks });
	const before = editor.getTracks();

	const result = editor.resizeElements({
		elements: [{ trackId: "video", elementId: "clip" }],
		side: "right",
		deltaTime: 10 * SECOND,
		fps: { numerator: 30, denominator: 1 },
	});
	assert.deepEqual(result, {
		applied: true,
		deltaTime: SECOND / 2,
		updates: [
			{
				trackId: "video",
				elementId: "clip",
				patch: {
					trimStart: 0,
					trimEnd: SECOND / 2,
					startTime: 0,
					duration: SECOND + SECOND / 2,
				},
			},
		],
	});
	const resized = editor.getTracks();
	assert.equal(
		findElement(resized, "video", "clip")?.duration,
		SECOND + SECOND / 2,
	);
	assert.equal(findElement(resized, "video", "clip")?.trimEnd, SECOND / 2);

	editor.undo();
	assert.deepEqual(editor.getTracks(), before);
	editor.redo();
	assert.deepEqual(editor.getTracks(), resized);
});

test("snaps resize delta to OpenCut frame ticks and enforces one-frame minimum", () => {
	const tracks = sceneTracks();
	tracks.overlay = [
		{
			id: "video",
			type: "video",
			elements: [
				element({ id: "clip", startTime: 0, duration: SECOND }),
			],
		},
	];
	const editor = createOpenCutCommandEditor({ tracks });

	const rounded = editor.resizeElements({
		elements: [{ trackId: "video", elementId: "clip" }],
		side: "right",
		deltaTime: 5_999,
		fps: { numerator: 30, denominator: 1 },
	});
	assert.equal(rounded?.deltaTime, 4_000);
	assert.equal(
		findElement(editor.getTracks(), "video", "clip")?.duration,
		SECOND + 4_000,
	);
	editor.undo();

	const result = editor.resizeElements({
		elements: [{ trackId: "video", elementId: "clip" }],
		side: "right",
		deltaTime: -10 * SECOND,
		fps: { numerator: 30, denominator: 1 },
	});
	assert.equal(result?.deltaTime, 4_000 - SECOND);
	assert.equal(findElement(editor.getTracks(), "video", "clip")?.duration, 4_000);
});

test("clamps trim extension at the OpenCut source-duration boundary", () => {
	const tracks = sceneTracks();
	tracks.overlay = [
		{
			id: "video",
			type: "video",
			elements: [
				element({
					id: "clip",
					startTime: 0,
					duration: SECOND,
					trimEnd: SECOND,
					sourceDuration: 2 * SECOND,
				}),
			],
		},
	];
	const editor = createOpenCutCommandEditor({ tracks });

	const result = editor.resizeElements({
		elements: [{ trackId: "video", elementId: "clip" }],
		side: "right",
		deltaTime: 100 * SECOND,
		fps: { numerator: 30, denominator: 1 },
	});
	assert.equal(result?.deltaTime, SECOND);
	assert.equal(findElement(editor.getTracks(), "video", "clip")?.duration, 2 * SECOND);
	assert.equal(findElement(editor.getTracks(), "video", "clip")?.trimEnd, 0);
});

test("splits IDs, absolute times, source trims, and preserves upstream redo semantics", () => {
	const tracks = sceneTracks();
	tracks.overlay = [
		{
			id: "video",
			type: "video",
			elements: [
				{
					...element({
						id: "clip",
						startTime: SECOND,
						duration: 4 * SECOND,
						trimStart: SECOND / 2,
						trimEnd: SECOND / 2,
						sourceDuration: 5 * SECOND,
					}),
					animations: {
						opacity: {
							keys: [
								{
									id: "opacity-start",
									time: 0,
									value: 0,
									segmentToNext: "linear",
									tangentMode: "flat",
								},
								{
									id: "opacity-end",
									time: 4 * SECOND,
									value: 1,
									segmentToNext: "linear",
									tangentMode: "flat",
								},
							],
						},
					},
				},
			],
		},
	];
	const editor = createOpenCutCommandEditor({ tracks });
	const before = editor.getTracks();

	const split = editor.splitElements({
		elements: [{ trackId: "video", elementId: "clip" }],
		splitTime: 3 * SECOND,
	});
	assert.equal(split.rightSideElements.length, 1);
	const rightId = split.rightSideElements[0].elementId;
	assert.notEqual(rightId, "clip");
	assert.match(
		rightId,
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);

	const splitTracks = editor.getTracks();
	const left = findElement(splitTracks, "video", "clip");
	const right = findElement(splitTracks, "video", rightId);
	assert.deepEqual(
		{
			startTime: left?.startTime,
			duration: left?.duration,
			trimStart: left?.trimStart,
			trimEnd: left?.trimEnd,
		},
		{
			startTime: SECOND,
			duration: 2 * SECOND,
			trimStart: SECOND / 2,
			trimEnd: 2 * SECOND + SECOND / 2,
		},
	);
	assert.deepEqual(
		{
			startTime: right?.startTime,
			duration: right?.duration,
			trimStart: right?.trimStart,
			trimEnd: right?.trimEnd,
		},
		{
			startTime: 3 * SECOND,
			duration: 2 * SECOND,
			trimStart: 2 * SECOND + SECOND / 2,
			trimEnd: SECOND / 2,
		},
	);
	const leftOpacity = left?.animations?.opacity as
		| { keys: Array<{ time: number }> }
		| undefined;
	const rightOpacity = right?.animations?.opacity as
		| { keys: Array<{ time: number }> }
		| undefined;
	assert.deepEqual(leftOpacity?.keys.map((key) => key.time), [0, 2 * SECOND]);
	assert.deepEqual(rightOpacity?.keys.map((key) => key.time), [0, 2 * SECOND]);

	editor.undo();
	assert.deepEqual(editor.getTracks(), before);

	// OpenCut's base Command.redo() calls execute(), so SplitElementsCommand
	// intentionally allocates a fresh right-side UUID on redo.
	editor.redo();
	const redoneElements = editor.getTracks().overlay[0].elements;
	assert.equal(redoneElements.length, 2);
	const redoneRight = redoneElements.find((item) => item.id !== "clip");
	assert.notEqual(redoneRight?.id, rightId);
	assert.equal(redoneRight?.startTime, 3 * SECOND);
	assert.equal(redoneRight?.duration, 2 * SECOND);

	editor.undo();
	assert.deepEqual(editor.getTracks(), before);
});

test("uses OpenCut PlaybackManager for frame-rounded playback and terminal seek", () => {
	const originalPerformance = Object.getOwnPropertyDescriptor(
		globalThis,
		"performance",
	);
	const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
	const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
	let now = 0;
	let nextFrameId = 0;
	const frames = new Map<number, FrameRequestCallback>();

	Object.defineProperty(globalThis, "performance", {
		configurable: true,
		value: { now: () => now },
	});
	globalThis.requestAnimationFrame = (callback) => {
		const id = ++nextFrameId;
		frames.set(id, callback);
		return id;
	};
	globalThis.cancelAnimationFrame = (id) => {
		frames.delete(id);
	};

	const tracks = sceneTracks();
	tracks.overlay = [{
		id: "video",
		type: "video",
		elements: [element({ id: "clip", startTime: 0, duration: SECOND })],
	}];
	const editor = createOpenCutCommandEditor({ tracks });
	const updates: number[] = [];
	const seeks: number[] = [];
	const unsubscribeUpdate = editor.playback.onUpdate((time) => updates.push(time));
	const unsubscribeSeek = editor.playback.onSeek((time) => seeks.push(time));

	const runNextFrame = (wallTime: number) => {
		now = wallTime;
		const entry = frames.entries().next().value as
			| [number, FrameRequestCallback]
			| undefined;
		assert.ok(entry, "OpenCut should have scheduled the next animation frame");
		frames.delete(entry[0]);
		entry[1](wallTime);
	};

	try {
		assert.deepEqual(editor.playback.getSnapshot(), {
			isPlaying: false,
			currentTime: 0,
			duration: SECOND,
			volume: 1,
			muted: false,
			isScrubbing: false,
		});

		editor.playback.play();
		assert.equal(editor.playback.getSnapshot().isPlaying, true);
		runNextFrame(101);
		// 101ms is 12,120 ticks; OpenCut rounds it to the 10,000-tick 24fps frame.
		assert.equal(editor.playback.getSnapshot().currentTime, 10_000);
		assert.deepEqual(updates, [0, 10_000]);

		runNextFrame(1_001);
		assert.equal(editor.playback.getSnapshot().isPlaying, false);
		assert.equal(editor.playback.getSnapshot().currentTime, SECOND);
		assert.deepEqual(seeks, [SECOND]);
		assert.equal(frames.size, 0);

		editor.playback.seek(SECOND * 2);
		assert.equal(editor.playback.getSnapshot().currentTime, SECOND);
		editor.playback.setVolume(2);
		assert.equal(editor.playback.getSnapshot().volume, 1);
		editor.playback.mute();
		assert.equal(editor.playback.getSnapshot().muted, true);
		editor.playback.unmute();
		assert.equal(editor.playback.getSnapshot().volume, 1);
	} finally {
		editor.playback.pause();
		unsubscribeUpdate();
		unsubscribeSeek();
		if (originalPerformance) {
			Object.defineProperty(globalThis, "performance", originalPerformance);
		} else {
			Reflect.deleteProperty(globalThis, "performance");
		}
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
	}
});

test("rejects invalid playback frame rates at the adapter boundary", () => {
	assert.throws(
		() => createOpenCutCommandEditor({
			tracks: sceneTracks(),
			frameRate: { numerator: 0, denominator: 1 },
		}),
		/frameRate must contain positive safe integers/,
	);
});
