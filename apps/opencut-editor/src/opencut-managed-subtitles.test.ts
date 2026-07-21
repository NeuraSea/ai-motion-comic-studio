import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCutCommandEditor } from "./index.js";
import type {
	EditorSceneTracks,
	ReplaceManagedSubtitleCueSetInput,
} from "./contracts.js";

const SECOND = 120_000;
const HALF_SECOND = 60_000;

function sceneTracks(): EditorSceneTracks {
	return {
		overlay: [
			{
				id: "manual-text",
				name: "手工字幕",
				type: "text",
				hidden: false,
				elements: [
					{
						id: "manual-cue",
						type: "text",
						name: "保留我",
						startTime: 0,
						duration: HALF_SECOND,
						trimStart: 0,
						trimEnd: 0,
						params: { content: "保留我", text: "保留我" },
					},
				],
			},
		],
		main: {
			id: "main",
			name: "主轨",
			type: "video",
			elements: [],
		},
		audio: [
			{
				id: "dialogue-audio",
				name: "对白",
				type: "audio",
				elements: [
					{
						id: "audio-line-1",
						type: "audio",
						name: "第一句对白",
						sourceType: "upload",
						mediaId: "speech-asset-1",
						startTime: SECOND,
						duration: 2 * SECOND,
						trimStart: 0,
						trimEnd: 0,
						params: {
							dialogueLineId: "line-1",
							storySceneId: "scene-1",
							storyShotId: "shot-1",
							storyManagedAssetId: "speech-asset-1",
						},
					},
				],
			},
		],
	};
}

function subtitleInput(
	overrides: Partial<ReplaceManagedSubtitleCueSetInput> = {},
): ReplaceManagedSubtitleCueSetInput {
	return {
		cueSetId: "cue-set-1",
		dialogueLineId: "line-1",
		storySceneId: "scene-1",
		storyShotId: "shot-1",
		speechAssetId: "speech-asset-1",
		sourceAudioElementId: "audio-line-1",
		sourceAudioStartTime: SECOND,
		sourceAudioTrimStart: 0,
		sourceAudioDuration: 2 * SECOND,
		cues: [
			{
				text: "你好",
				startTime: SECOND,
				duration: HALF_SECOND,
				sourceStartMs: 0,
				sourceEndMs: 500,
			},
			{
				text: "世界",
				startTime: SECOND + HALF_SECOND,
				duration: HALF_SECOND,
				sourceStartMs: 500,
				sourceEndMs: 1_000,
			},
		],
		...overrides,
	};
}

test("materializes the exact managed subtitle wire shape in one atomic command", () => {
	const before = sceneTracks();
	const editor = createOpenCutCommandEditor({ tracks: before });
	const snapshot = editor.replaceManagedSubtitleCueSet(subtitleInput());
	const after = editor.getTracks();
	const track = after.overlay.find((item) => item.id === snapshot.trackId);

	assert.ok(track);
	assert.equal(track.type, "text");
	assert.equal(track.elements.length, 2);
	assert.equal(after.overlay[0]?.elements[0]?.id, "manual-cue");
	const first = track.elements[0]!;
	assert.equal(first.name, "你好");
	assert.deepEqual(first.params, {
		content: "你好",
		text: "你好",
		manjuRole: "speech-subtitle",
		dialogueLineId: "line-1",
		storySceneId: "scene-1",
		storyShotId: "shot-1",
		speechAssetId: "speech-asset-1",
		sourceAudioElementId: "audio-line-1",
		subtitleCueSetId: "cue-set-1",
		sourceCueIndex: 0,
	});
	assert.deepEqual(first.manju, {
		subtitleCue: {
			version: 1,
			cueSetId: "cue-set-1",
			dialogueLineId: "line-1",
			storySceneId: "scene-1",
			storyShotId: "shot-1",
			speechAssetId: "speech-asset-1",
			sourceAudioElementId: "audio-line-1",
			sourceCueIndex: 0,
			sourceStartMs: 0,
			sourceEndMs: 500,
			sourceAudioStartTime: SECOND,
			sourceAudioTrimStart: 0,
			sourceAudioDuration: 2 * SECOND,
		},
	});
	assert.equal(snapshot.stale, false);
	assert.deepEqual(
		editor.readManagedSubtitleCueSet("line-1", "speech-asset-1"),
		snapshot,
	);

	assert.equal(editor.canUndo(), true);
	editor.undo();
	assert.deepEqual(editor.getTracks(), before);
	assert.equal(editor.canUndo(), false);
	assert.equal(editor.canRedo(), true);
	editor.redo();
	assert.deepEqual(editor.getTracks(), after);
	assert.deepEqual(
		editor
			.readManagedSubtitleCueSet("line-1", "speech-asset-1")
			?.cues.map((cue) => cue.elementId),
		snapshot.cues.map((cue) => cue.elementId),
	);
});

test("replacement removes the old group and reuses IDs for the same cue set/index", () => {
	const editor = createOpenCutCommandEditor({ tracks: sceneTracks() });
	const first = editor.replaceManagedSubtitleCueSet(subtitleInput());
	editor.clearHistory();
	const beforeReplacement = editor.getTracks();
	const replacement = editor.replaceManagedSubtitleCueSet(
		subtitleInput({
			cues: [
				{
					text: "  新的第一句\r\n第二行  ",
					startTime: SECOND,
					duration: HALF_SECOND,
					sourceStartMs: 0,
					sourceEndMs: 500,
				},
				{
					text: "新的第二句",
					startTime: SECOND + HALF_SECOND,
					duration: HALF_SECOND,
					sourceStartMs: 500,
					sourceEndMs: 1_000,
				},
			],
		}),
	);
	const afterReplacement = editor.getTracks();

	assert.deepEqual(
		replacement.cues.map((cue) => cue.elementId),
		first.cues.map((cue) => cue.elementId),
	);
	assert.equal(replacement.cues[0]?.text, "新的第一句\n第二行");
	assert.equal(
		afterReplacement.overlay
			.flatMap((track) => track.elements)
			.filter(
				(element) => element.params?.dialogueLineId === "line-1",
			).length,
		2,
	);

	editor.undo();
	assert.deepEqual(editor.getTracks(), beforeReplacement);
	assert.equal(editor.canUndo(), false);
	editor.redo();
	assert.deepEqual(editor.getTracks(), afterReplacement);
});

test("read marks managed cues stale after source audio or requested asset changes", () => {
	const editor = createOpenCutCommandEditor({ tracks: sceneTracks() });
	editor.replaceManagedSubtitleCueSet(subtitleInput());
	const wrongAsset = editor.readManagedSubtitleCueSet(
		"line-1",
		"speech-asset-new",
	);
	assert.equal(wrongAsset?.stale, true);
	assert.ok(wrongAsset?.staleReasons.includes("speech-asset-mismatch"));

	editor.commitElementUpdates({
		updates: [
			{
				trackId: "dialogue-audio",
				elementId: "audio-line-1",
				patch: {
					trimStart: 0,
					trimEnd: 0,
					startTime: SECOND + 5_000,
					duration: 2 * SECOND,
				},
			},
		],
	});
	const moved = editor.readManagedSubtitleCueSet("line-1", "speech-asset-1");
	assert.equal(moved?.stale, true);
	assert.ok(moved?.staleReasons.includes("source-audio-start-mismatch"));

	editor.undo();
	assert.equal(
		editor.readManagedSubtitleCueSet("line-1", "speech-asset-1")?.stale,
		false,
	);
});

test("strict failures leave tracks and command history untouched", () => {
	const editor = createOpenCutCommandEditor({ tracks: sceneTracks() });
	const before = editor.getTracks();
	const valid = subtitleInput();
	const invalid: ReplaceManagedSubtitleCueSetInput[] = [
		subtitleInput({ cues: [] }),
		subtitleInput({
			cues: valid.cues.map((cue, index) =>
				index === 0 ? { ...cue, startTime: cue.startTime + 1 } : cue,
			),
		}),
		subtitleInput({
			cues: valid.cues.map((cue, index) =>
				index === 1 ? { ...cue, startTime: 150_000 } : cue,
			),
		}),
		subtitleInput({
			cues: valid.cues.map((cue, index) =>
				index === 0 ? { ...cue, startTime: 0 } : cue,
			),
		}),
		subtitleInput({
			cues: valid.cues.map((cue, index) =>
				index === 1 ? { ...cue, sourceEndMs: 2_500 } : cue,
			),
		}),
		subtitleInput({ sourceAudioDuration: SECOND }),
	];

	for (const input of invalid) {
		assert.throws(() => editor.replaceManagedSubtitleCueSet(input));
		assert.deepEqual(editor.getTracks(), before);
		assert.equal(editor.canUndo(), false);
		assert.equal(editor.canRedo(), false);
	}
});
