import assert from "node:assert/strict";
import test from "node:test";

import {
	canonicalTimelineDocumentFromTracks,
	compileRenderSemanticPlan,
	renderSemanticPlanBoundarySignature,
	renderSemanticVisualOpacityAtFrame,
	RenderSemanticPlanError,
} from "./index.js";

const FRAME_TICKS = 5_000;
const CHECKSUM = "a".repeat(64);

function opacityKey(id: string, frame: number, value: 0 | 1) {
	return {
		id,
		time: frame * FRAME_TICKS,
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

function compile(animations: Record<string, unknown>) {
	const document = canonicalTimelineDocumentFromTracks({
		overlay: [],
		main: {
			id: "main",
			type: "video",
			elements: [{
				id: "shot",
				type: "image",
				mediaId: "image",
				name: "shot",
				startTime: 0,
				duration: 48 * FRAME_TICKS,
				trimStart: 0,
				trimEnd: 0,
				params: { fit: "cover" },
				animations,
			}],
		},
		audio: [],
	}, { frameRate: { numerator: 24, denominator: 1 } });
	return compileRenderSemanticPlan({
		timelineDocument: document,
		timelineDocumentId: "timeline",
		timelineRevisionId: "revision",
		storyRevisionId: "story",
		aspectRatio: "16:9",
		assets: [{ assetId: "image", version: 1, checksum: CHECKSUM, mediaType: "image" }],
	});
}

test("compiles frame-aligned OpenCut opacity fade-in/out and exposes one shared evaluator", () => {
	const plan = compile({
		opacity: {
			keys: [
				opacityKey("in-start", 0, 0),
				opacityKey("in-end", 12, 1),
				opacityKey("out-start", 36, 1),
				opacityKey("out-end", 48, 0),
			],
			extrapolation: { before: "hold", after: "hold" },
		},
	});
	const clip = plan.visualClips[0]!;
	assert.equal(plan.version, 5);
	assert.deepEqual(clip.opacityFade, {
		version: 1,
		fadeIn: { startFrame: 0, durationFrames: 12 },
		fadeOut: { startFrame: 36, durationFrames: 12 },
	});
	assert.equal(renderSemanticVisualOpacityAtFrame(clip, 0), 0);
	assert.equal(renderSemanticVisualOpacityAtFrame(clip, 6), 0.5);
	assert.equal(renderSemanticVisualOpacityAtFrame(clip, 12), 1);
	assert.equal(renderSemanticVisualOpacityAtFrame(clip, 36), 1);
	assert.equal(renderSemanticVisualOpacityAtFrame(clip, 42), 0.5);
	assert.equal(renderSemanticVisualOpacityAtFrame(clip, 47), 0.083333);
	assert.equal(renderSemanticVisualOpacityAtFrame(clip, 48), 0);
	assert.ok(Object.isFrozen(clip.opacityFade));

	const samples = JSON.parse(renderSemanticPlanBoundarySignature(plan)) as Array<{
		frame: number;
		visual: Array<{ opacity?: number }>;
	}>;
	assert.equal(samples.find((sample) => sample.frame === 6)?.visual[0]?.opacity, undefined);
	assert.equal(samples.find((sample) => sample.frame === 11)?.visual[0]?.opacity, 0.916667);
	assert.equal(samples.find((sample) => sample.frame === 12)?.visual[0]?.opacity, 1);
	assert.equal(samples.find((sample) => sample.frame === 37)?.visual[0]?.opacity, 0.916667);
});

test("fails closed for unknown channels, non-binary opacity, handles, and unsupported interpolation", () => {
	const invalid: Array<Record<string, unknown>> = [
		{
			opacity: { keys: [opacityKey("a", 0, 0), opacityKey("b", 12, 1)] },
			"transform.positionX": { keys: [opacityKey("x", 0, 0), opacityKey("y", 12, 1)] },
		},
		{
			opacity: {
				keys: [
					opacityKey("a", 0, 0),
					{ ...opacityKey("b", 12, 1), value: 0.5 },
				],
			},
		},
		{
			opacity: {
				keys: [
					{ ...opacityKey("a", 0, 0), rightHandle: { dt: 1, dv: 1 } },
					opacityKey("b", 12, 1),
				],
			},
		},
		{
			opacity: {
				keys: [
					{ ...opacityKey("a", 0, 0), segmentToNext: "bezier" },
					opacityKey("b", 12, 1),
				],
			},
		},
	];
	for (const animations of invalid) {
		assert.throws(
			() => compile(animations),
			(error: unknown) => error instanceof RenderSemanticPlanError
				&& error.code === "UNSUPPORTED_TIMELINE",
		);
	}
});

test("fails closed for reversed or repeated opacity direction changes", () => {
	assert.throws(
		() => compile({
			opacity: {
				keys: [
					opacityKey("a", 0, 1),
					opacityKey("b", 12, 0),
					opacityKey("c", 24, 1),
				],
			},
		}),
		(error: unknown) => error instanceof RenderSemanticPlanError
			&& error.code === "UNSUPPORTED_TIMELINE",
	);
});
