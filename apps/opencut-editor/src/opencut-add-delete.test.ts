import assert from "node:assert/strict";
import test from "node:test";
import {
	canonicalTimelineDocumentFromTracks,
	createOpenCutCommandEditor,
} from "./index.js";
import type {
	EditorCreateBaseTimelineElement,
	EditorCreateTimelineElement,
	EditorSceneTracks,
	EditorTimelineElement,
	EditorTrackType,
} from "./contracts.js";

const SECOND = 120_000;

function sceneTracks(): EditorSceneTracks {
	return {
		overlay: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			elements: [],
			hidden: false,
			muted: false,
		},
		audio: [],
	};
}

function base(
	name: string,
	startTime = 0,
): EditorCreateBaseTimelineElement {
	return {
		name,
		startTime,
		duration: SECOND,
		trimStart: 0,
		trimEnd: 0,
		params: {},
	};
}

function findElement(
	tracks: EditorSceneTracks,
	trackId: string,
	elementId: string,
): EditorTimelineElement | undefined {
	return [...tracks.overlay, tracks.main, ...tracks.audio]
		.find((track) => track.id === trackId)
		?.elements.find((element) => element.id === elementId);
}

test("AddTrackCommand keeps pinned ordering, default metadata, selection, and history semantics", () => {
	const before = sceneTracks();
	const editor = createOpenCutCommandEditor({ tracks: before });
	const added = editor.addTrack({ type: "text", index: 0 });
	const after = editor.getTracks();

	assert.deepEqual(after.overlay[0], {
		id: added.trackId,
		name: "Text track",
		type: "text",
		elements: [],
		hidden: false,
	});
	assert.deepEqual(editor.getSelection().selectedElements, []);

	editor.undo();
	assert.deepEqual(editor.getTracks(), before);
	assert.deepEqual(editor.getSelection().selectedElements, []);
	editor.redo();
	assert.deepEqual(editor.getTracks(), after);
	assert.equal(editor.getTracks().overlay[0]?.id, added.trackId);
});

test("InsertElementCommand atomically inserts a canonical text element and selects it", () => {
	const editor = createOpenCutCommandEditor({ tracks: sceneTracks() });
	const { trackId } = editor.addTrack({ type: "text" });
	editor.clearHistory();
	const element: EditorCreateTimelineElement = {
		...base("字幕"),
		type: "text",
		params: { content: "一句字幕", fontSize: 48 },
		animations: {
			opacity: { keys: [{ id: "key-1", time: 0, value: 1 }] },
		},
		effects: [{ id: "shadow", enabled: true }],
		manju: { dialogueLineId: "line-1", style: { role: "caption" } },
	};
	const added = editor.addElement({
		element,
		placement: { mode: "explicit", trackId },
	});
	assert.ok(added);
	assert.deepEqual(added.trackId, trackId);
	assert.deepEqual(findElement(editor.getTracks(), trackId, added.elementId), {
		id: added.elementId,
		...element,
	});
	assert.deepEqual(editor.getSelection(), {
		selectedElements: [added],
		selectedKeyframes: [],
		keyframeSelectionAnchor: null,
		selectedMaskPoints: null,
	});

	editor.undo();
	assert.equal(findElement(editor.getTracks(), trackId, added.elementId), undefined);
	assert.deepEqual(editor.getSelection().selectedElements, []);
	editor.redo();
	assert.deepEqual(findElement(editor.getTracks(), trackId, added.elementId), {
		id: added.elementId,
		...element,
	});
	assert.deepEqual(editor.getSelection().selectedElements, [added]);
});

test("UI-driven element selection is part of OpenCut command history", () => {
	const editor = createOpenCutCommandEditor({ tracks: sceneTracks() });
	const first = editor.addElement({
		element: {
			...base("first", 0),
			type: "image",
			mediaId: "asset-first",
		},
		placement: { mode: "auto" },
	});
	const second = editor.addElement({
		element: {
			...base("second", SECOND),
			type: "image",
			mediaId: "asset-second",
		},
		placement: { mode: "auto" },
	});
	assert.ok(first);
	assert.ok(second);

	assert.deepEqual(
		editor.setSelectedElements([first]).selectedElements,
		[first],
	);
	editor.deleteElements({ elements: [first] });
	assert.deepEqual(editor.getSelection().selectedElements, []);
	editor.undo();
	assert.deepEqual(editor.getSelection().selectedElements, [first]);
	const restored = editor.getTracks();
	assert.ok([...restored.overlay, restored.main, ...restored.audio]
		.flatMap((track) => track.elements)
		.some((element) => element.id === first.elementId));
});

test("audio property edits delegate to UpdateElementsCommand and round-trip history", () => {
	const editor = createOpenCutCommandEditor({ tracks: sceneTracks() });
	const added = editor.addElement({
		element: {
			...base("BGM", 0),
			type: "audio",
			sourceType: "upload",
			mediaId: "asset-bgm",
			params: { audioRole: "bgm", volume: 0.65 },
		},
		placement: { mode: "auto", trackType: "audio" },
	});
	assert.ok(added);
	editor.clearHistory();

	editor.commitElementPropertyUpdates({
		updates: [{
			...added,
			patch: {
				params: {
					audioRole: "bgm",
					volume: 0.4,
					fadeInSeconds: 1,
					fadeOutSeconds: 2,
				},
			},
		}],
	});
	assert.deepEqual(
		findElement(editor.getTracks(), added.trackId, added.elementId)?.params,
		{
			audioRole: "bgm",
			volume: 0.4,
			fadeInSeconds: 1,
			fadeOutSeconds: 2,
		},
	);
	editor.undo();
	assert.deepEqual(
		findElement(editor.getTracks(), added.trackId, added.elementId)?.params,
		{ audioRole: "bgm", volume: 0.65 },
	);
	editor.redo();
	assert.equal(
		findElement(editor.getTracks(), added.trackId, added.elementId)?.params?.fadeOutSeconds,
		2,
	);
});

test("video source-audio edits delegate to UpdateElementsCommand and round-trip history", () => {
	const editor = createOpenCutCommandEditor({ tracks: sceneTracks() });
	const added = editor.addElement({
		element: {
			...base("Seedance SFX", 0),
			type: "video",
			mediaId: "asset-seedance-video",
			isSourceAudioEnabled: true,
			params: { audioRole: "sfx", volume: 1 },
		},
		placement: { mode: "auto", trackType: "video" },
	});
	assert.ok(added);
	editor.clearHistory();

	editor.commitElementPropertyUpdates({
		updates: [{
			...added,
			patch: {
				isSourceAudioEnabled: false,
				params: { audioRole: "sfx", volume: 0.5 },
			},
		}],
	});
	const muted = findElement(editor.getTracks(), added.trackId, added.elementId);
	assert.equal(muted?.isSourceAudioEnabled, false);
	assert.equal(muted?.params?.volume, 0.5);
	editor.undo();
	assert.equal(
		findElement(editor.getTracks(), added.trackId, added.elementId)?.isSourceAudioEnabled,
		true,
	);
	editor.redo();
	assert.equal(
		findElement(editor.getTracks(), added.trackId, added.elementId)?.isSourceAudioEnabled,
		false,
	);
});

test("DeleteElementsCommand deletes a batch, clears selection, and restores both on undo", () => {
	const editor = createOpenCutCommandEditor({ tracks: sceneTracks() });
	const { trackId } = editor.addTrack({ type: "audio" });
	const upload: EditorCreateTimelineElement = {
		...base("BGM"),
		type: "audio",
		sourceType: "upload",
		mediaId: "asset-bgm",
		params: { volume: 0.65, category: "bgm" },
		retime: { rate: 1, maintainPitch: true },
		manju: { role: "bgm" },
	};
	const library: EditorCreateTimelineElement = {
		...base("SFX", SECOND),
		type: "audio",
		sourceType: "library",
		sourceUrl: "https://media.example/sfx.wav",
		params: { volume: 1, category: "sfx" },
		manju: { role: "sfx" },
	};
	const first = editor.addElement({
		element: upload,
		placement: { mode: "explicit", trackId },
	});
	const second = editor.addElement({
		element: library,
		placement: { mode: "explicit", trackId },
	});
	assert.ok(first);
	assert.ok(second);
	assert.deepEqual(findElement(editor.getTracks(), trackId, first.elementId), {
		id: first.elementId,
		...upload,
	});
	assert.deepEqual(findElement(editor.getTracks(), trackId, second.elementId), {
		id: second.elementId,
		...library,
	});
	assert.deepEqual(editor.getSelection().selectedElements, [second]);
	const beforeDelete = editor.getTracks();

	editor.deleteElements({ elements: [first, second] });
	assert.equal(findElement(editor.getTracks(), trackId, first.elementId), undefined);
	assert.equal(findElement(editor.getTracks(), trackId, second.elementId), undefined);
	assert.deepEqual(editor.getSelection().selectedElements, []);

	editor.undo();
	assert.deepEqual(editor.getTracks(), beforeDelete);
	assert.deepEqual(editor.getSelection().selectedElements, [second]);
	editor.redo();
	assert.equal(findElement(editor.getTracks(), trackId, first.elementId), undefined);
	assert.equal(findElement(editor.getTracks(), trackId, second.elementId), undefined);
	assert.deepEqual(editor.getSelection().selectedElements, []);
});

test("automatic insertion delegates collision and new-track placement to pinned OpenCut", () => {
	const tracks = sceneTracks();
	tracks.overlay.push({
		id: "captions",
		name: "Captions",
		type: "text",
		hidden: false,
		elements: [
			{
				id: "occupied",
				name: "Occupied",
				type: "text",
				startTime: 0,
				duration: 2 * SECOND,
				trimStart: 0,
				trimEnd: 0,
				params: { content: "existing" },
			},
		],
	});
	const editor = createOpenCutCommandEditor({ tracks });
	const added = editor.addElement({
		element: {
			...base("Overlapping caption"),
			type: "text",
			params: { content: "new" },
		},
		placement: { mode: "auto" },
	});
	assert.ok(added);
	assert.notEqual(added.trackId, "captions");
	assert.equal(editor.getTracks().overlay.length, 2);
	assert.equal(findElement(editor.getTracks(), "captions", "occupied")?.id, "occupied");

	editor.undo();
	assert.deepEqual(editor.getTracks(), tracks);
	assert.deepEqual(editor.getSelection().selectedElements, []);
	editor.redo();
	assert.equal(editor.getTracks().overlay.length, 2);
	assert.equal(
		[...editor.getTracks().overlay]
			.flatMap((track) => track.elements)
			.some((element) => element.id === added.elementId),
		true,
	);
});

test("addElement preserves every canonical subtype discriminant through serialization", () => {
	const editor = createOpenCutCommandEditor({ tracks: sceneTracks() });
	const trackIds = new Map<EditorTrackType, string>();
	for (const type of ["video", "graphic", "effect"] as const) {
		trackIds.set(type, editor.addTrack({ type }).trackId);
	}
	const elements: Array<{
		element: EditorCreateTimelineElement;
		trackType: EditorTrackType;
	}> = [
		{
			element: {
				...base("Video"),
				type: "video",
				mediaId: "asset-video",
				isSourceAudioEnabled: false,
				masks: [{ id: "mask-video" }],
			},
			trackType: "video",
		},
		{
			element: {
				...base("Image", SECOND),
				type: "image",
				mediaId: "asset-image",
				masks: [{ id: "mask-image" }],
			},
			trackType: "video",
		},
		{
			element: {
				...base("Sticker"),
				type: "sticker",
				stickerId: "sticker-star",
				intrinsicWidth: 640,
				intrinsicHeight: 480,
			},
			trackType: "graphic",
		},
		{
			element: {
				...base("Graphic", SECOND),
				type: "graphic",
				definitionId: "lower-third",
				masks: [{ id: "mask-graphic" }],
			},
			trackType: "graphic",
		},
		{
			element: {
				...base("Effect"),
				type: "effect",
				effectType: "blur",
			},
			trackType: "effect",
		},
	];

	for (const item of elements) {
		const trackId = trackIds.get(item.trackType);
		assert.ok(trackId);
		const added = editor.addElement({
			element: item.element,
			placement: { mode: "explicit", trackId },
		});
		assert.ok(added);
		assert.deepEqual(findElement(editor.getTracks(), trackId, added.elementId), {
			id: added.elementId,
			...item.element,
		});
	}

	const canonical = canonicalTimelineDocumentFromTracks(editor.getTracks());
	assert.equal(canonical.tracks.overlay[0]?.elements[0]?.type, "effect");
	assert.equal(
		canonical.tracks.overlay
			.flatMap((track) => track.elements)
			.filter((element) => element.type === "video")[0]?.mediaId,
		"asset-video",
	);
	assert.equal(
		canonical.tracks.overlay
			.flatMap((track) => track.elements)
			.filter((element) => element.type === "graphic")[0]?.definitionId,
		"lower-third",
	);
});
