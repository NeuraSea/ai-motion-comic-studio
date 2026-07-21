import assert from "node:assert/strict";
import test from "node:test";

import type { EditorSceneTracks } from "./contracts.js";
import {
	applyOpenCutAtomicEdit,
	OpenCutAtomicEditError,
} from "./opencut-atomic-edit.js";

const FRAME = 5_000;

function tracks(): EditorSceneTracks {
	return {
		overlay: [
		{
			id: "visual-main",
			name: "Visual",
			type: "video",
			hidden: false,
			muted: false,
			elements: [
				{
					id: "tail",
					name: "Tail",
					type: "image",
					mediaId: "image-1",
					startTime: 20 * FRAME,
					duration: 10 * FRAME,
					trimStart: 0,
					trimEnd: 0,
					params: {},
				},
			],
		},
	],
	main: {
		id: "main",
		name: "Main",
		type: "video",
		hidden: false,
		muted: false,
		elements: [],
	},
	audio: [
		{
			id: "dialogue-main",
			name: "Dialogue",
			type: "audio",
			muted: false,
			elements: [
				{
					id: "line-1",
					name: "Line 1",
					type: "audio",
					sourceType: "upload",
					mediaId: "speech-1",
					startTime: 16 * FRAME,
					duration: 4 * FRAME,
					trimStart: 0,
					trimEnd: 0,
					params: {},
				},
			],
		},
	],
	};
}

test("applies a multi-element automation as one OpenCut timing command", () => {
	const before = tracks();
	const result = applyOpenCutAtomicEdit({
		tracks: before,
		operations: [
			{
				kind: "update-element-timing",
				trackId: "dialogue-main",
				elementId: "line-1",
				reason: "managed-dialogue-story-order",
				before: {
					startTime: 16 * FRAME,
					duration: 4 * FRAME,
					trimStart: 0,
					trimEnd: 0,
				},
				after: {
					startTime: 0,
					duration: 8 * FRAME,
					trimStart: 0,
					trimEnd: 0,
				},
			},
			{
				kind: "update-element-timing",
				trackId: "visual-main",
				elementId: "tail",
				reason: "extend-managed-image-tail",
				before: {
					startTime: 20 * FRAME,
					duration: 10 * FRAME,
					trimStart: 0,
					trimEnd: 0,
				},
				after: {
					startTime: 20 * FRAME,
					duration: 12 * FRAME,
					trimStart: 0,
					trimEnd: 0,
				},
			},
		],
	});
	assert.deepEqual(result.changedElementIds, ["line-1", "tail"]);
	assert.equal(result.tracks.audio[0].elements[0].startTime, 0);
	assert.equal(result.tracks.audio[0].elements[0].duration, 8 * FRAME);
	assert.equal(result.tracks.overlay[0].elements[0].duration, 12 * FRAME);
	assert.equal(before.audio[0].elements[0].startTime, 16 * FRAME);
	assert.equal(before.overlay[0].elements[0].duration, 10 * FRAME);
});

test("fails the whole transaction when an element precondition is stale", () => {
	const before = tracks();
	assert.throws(
		() => applyOpenCutAtomicEdit({
			tracks: before,
			operations: [
				{
					kind: "update-element-timing",
					trackId: "dialogue-main",
					elementId: "line-1",
					reason: "managed-dialogue-story-order",
					before: {
						startTime: 15 * FRAME,
						duration: 4 * FRAME,
						trimStart: 0,
						trimEnd: 0,
					},
					after: {
						startTime: 0,
						duration: 8 * FRAME,
						trimStart: 0,
						trimEnd: 0,
					},
				},
			],
		}),
		(error: unknown) =>
			error instanceof OpenCutAtomicEditError &&
			error.code === "PRECONDITION_FAILED",
	);
	assert.equal(before.audio[0].elements[0].startTime, 16 * FRAME);
});

test("rejects duplicate operations instead of relying on update order", () => {
	const operation = {
		kind: "update-element-timing" as const,
		trackId: "dialogue-main",
		elementId: "line-1",
		reason: "managed-dialogue-story-order",
		before: {
			startTime: 16 * FRAME,
			duration: 4 * FRAME,
			trimStart: 0,
			trimEnd: 0,
		},
		after: {
			startTime: 0,
			duration: 8 * FRAME,
			trimStart: 0,
			trimEnd: 0,
		},
	};
	assert.throws(
		() => applyOpenCutAtomicEdit({ tracks: tracks(), operations: [operation, operation] }),
		(error: unknown) =>
			error instanceof OpenCutAtomicEditError &&
			error.code === "DUPLICATE_OPERATION",
	);
});
