import assert from "node:assert/strict";
import test from "node:test";

import {
	canonicalTimelineDocumentFromTracks,
	compileRenderSemanticPlan,
	renderSemanticPlanBoundarySignature,
	renderSemanticVisualOpacityAtFrame,
	renderSemanticVisualScaleAtFrame,
	RenderSemanticPlanError,
} from "./index.js";

const FRAME_TICKS = 5_000;
const CLIP_FRAMES = 48;
const CHECKSUM = "e".repeat(64);

function animationKey(id: string, frame: number, value: number) {
	return {
		id,
		time: frame * FRAME_TICKS,
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

function scaleChannel(axis: "x" | "y", fromScale: number, toScale: number) {
	return {
		keys: [
			animationKey(`${axis}-start`, 0, fromScale),
			animationKey(`${axis}-end`, CLIP_FRAMES, toScale),
		],
		extrapolation: { before: "hold", after: "hold" },
	};
}

function uniformScaleAnimations(fromScale: number, toScale: number): Record<string, unknown> {
	return {
		"transform.scaleX": scaleChannel("x", fromScale, toScale),
		"transform.scaleY": scaleChannel("y", fromScale, toScale),
	};
}

function compile(
	animations: Record<string, unknown>,
	mediaType: "image" | "video" = "image",
) {
	const element = {
		id: "shot",
		type: mediaType,
		mediaId: "visual",
		name: "shot",
		startTime: 0,
		duration: CLIP_FRAMES * FRAME_TICKS,
		trimStart: 0,
		trimEnd: 0,
		...(mediaType === "video" ? { sourceDuration: CLIP_FRAMES * FRAME_TICKS } : {}),
		params: { fit: "cover" },
		animations,
	};
	const document = canonicalTimelineDocumentFromTracks({
		overlay: [],
		main: {
			id: "main",
			type: "video",
			elements: [element],
		},
		audio: [],
	}, { frameRate: { numerator: 24, denominator: 1 } });
	return compileRenderSemanticPlan({
		timelineDocument: document,
		timelineDocumentId: "timeline",
		timelineRevisionId: "revision",
		storyRevisionId: "story",
		aspectRatio: "16:9",
		assets: [{
			assetId: "visual",
			version: 1,
			checksum: CHECKSUM,
			mediaType,
			...(mediaType === "video" ? { sourceDurationFrames: CLIP_FRAMES } : {}),
		}],
	});
}

function isPlanError(code: "INVALID_TIMELINE" | "UNSUPPORTED_TIMELINE") {
	return (error: unknown): boolean => error instanceof RenderSemanticPlanError
		&& error.code === code;
}

test("compiles centre-anchored push motion and samples first/middle/last scale", () => {
	const plan = compile(uniformScaleAnimations(1, 1.2));
	const clip = plan.visualClips[0]!;
	assert.equal(plan.version, 5);
	assert.deepEqual(clip.uniformScaleMotion, {
		version: 1,
		startFrame: 0,
		durationFrames: 48,
		fromScale: 1,
		toScale: 1.2,
		anchorX: 0.5,
		anchorY: 0.5,
	});
	assert.ok(Object.isFrozen(clip.uniformScaleMotion));
	assert.equal(renderSemanticVisualScaleAtFrame(clip, -1), 1);
	assert.equal(renderSemanticVisualScaleAtFrame(clip, 0), 1);
	assert.equal(renderSemanticVisualScaleAtFrame(clip, 12), 1.05);
	assert.equal(renderSemanticVisualScaleAtFrame(clip, 24), 1.1);
	assert.equal(renderSemanticVisualScaleAtFrame(clip, 47), 1.195833);
	assert.equal(renderSemanticVisualScaleAtFrame(clip, 48), 1);
	assert.equal(renderSemanticVisualScaleAtFrame(clip, Number.NaN), 1);

	const samples = JSON.parse(renderSemanticPlanBoundarySignature(plan)) as Array<{
		frame: number;
		visual: Array<{ scale?: number }>;
	}>;
	const scaleAt = (frame: number) => samples.find((sample) => sample.frame === frame)
		?.visual[0]?.scale;
	assert.equal(scaleAt(0), 1);
	assert.equal(scaleAt(24), 1.1);
	assert.equal(scaleAt(47), 1.195833);
});

test("compiles pull motion with independently named but synchronized axis keys", () => {
	const clip = compile(uniformScaleAnimations(1.2, 1)).visualClips[0]!;
	assert.equal(clip.uniformScaleMotion?.fromScale, 1.2);
	assert.equal(clip.uniformScaleMotion?.toScale, 1);
	assert.equal(renderSemanticVisualScaleAtFrame(clip, 24), 1.1);
});

test("canonicalizes scale values to six decimals for stable receipts", () => {
	const clip = compile(uniformScaleAnimations(1.0000004, 1.1999996)).visualClips[0]!;
	assert.equal(clip.uniformScaleMotion?.fromScale, 1);
	assert.equal(clip.uniformScaleMotion?.toScale, 1.2);
});

test("uniform scale coexists with the independently audited opacity channel", () => {
	const plan = compile({
		...uniformScaleAnimations(1, 1.2),
		opacity: {
			keys: [
				animationKey("opacity-start", 0, 0),
				animationKey("opacity-end", 12, 1),
			],
			extrapolation: { before: "hold", after: "hold" },
		},
	});
	const clip = plan.visualClips[0]!;
	assert.deepEqual(clip.opacityFade, {
		version: 1,
		fadeIn: { startFrame: 0, durationFrames: 12 },
		fadeOut: null,
	});
	assert.ok(clip.uniformScaleMotion);
	assert.equal(renderSemanticVisualOpacityAtFrame(clip, 6), 0.5);
	assert.equal(renderSemanticVisualScaleAtFrame(clip, 6), 1.025);
});

test("rejects fractional frames, desynchronized axes, unknown channels, and video", () => {
	const fractional = uniformScaleAnimations(1, 1.2);
	const fractionalX = fractional["transform.scaleX"] as {
		keys: Array<Record<string, unknown>>;
	};
	fractionalX.keys[1] = {
		...fractionalX.keys[1],
		time: CLIP_FRAMES * FRAME_TICKS - FRAME_TICKS / 2,
	};
	assert.throws(() => compile(fractional), isPlanError("INVALID_TIMELINE"));

	const desynchronized = uniformScaleAnimations(1, 1.2);
	const desynchronizedY = desynchronized["transform.scaleY"] as {
		keys: Array<Record<string, unknown>>;
	};
	desynchronizedY.keys[1] = { ...desynchronizedY.keys[1], value: 1.19 };
	assert.throws(() => compile(desynchronized), isPlanError("UNSUPPORTED_TIMELINE"));

	assert.throws(
		() => compile({
			...uniformScaleAnimations(1, 1.2),
			"transform.positionX": scaleChannel("x", 1, 1.2),
		}),
		isPlanError("UNSUPPORTED_TIMELINE"),
	);
	assert.throws(
		() => compile(uniformScaleAnimations(1, 1.2), "video"),
		isPlanError("UNSUPPORTED_TIMELINE"),
	);
});

test("rejects incomplete, static, non-hold, handled, or partial-clip scale channels", () => {
	const onlyScaleX = uniformScaleAnimations(1, 1.2);
	delete onlyScaleX["transform.scaleY"];
	assert.throws(() => compile(onlyScaleX), isPlanError("UNSUPPORTED_TIMELINE"));
	assert.throws(
		() => compile(uniformScaleAnimations(1.1, 1.1)),
		isPlanError("UNSUPPORTED_TIMELINE"),
	);

	const nonHold = uniformScaleAnimations(1, 1.2);
	const nonHoldX = nonHold["transform.scaleX"] as { extrapolation: Record<string, unknown> };
	nonHoldX.extrapolation.after = "linear";
	assert.throws(() => compile(nonHold), isPlanError("UNSUPPORTED_TIMELINE"));

	const handled = uniformScaleAnimations(1, 1.2);
	const handledX = handled["transform.scaleX"] as { keys: Array<Record<string, unknown>> };
	handledX.keys[0] = { ...handledX.keys[0], rightHandle: { dt: 1, dv: 0.01 } };
	assert.throws(() => compile(handled), isPlanError("UNSUPPORTED_TIMELINE"));

	const partial = uniformScaleAnimations(1, 1.2);
	const partialX = partial["transform.scaleX"] as { keys: Array<Record<string, unknown>> };
	const partialY = partial["transform.scaleY"] as { keys: Array<Record<string, unknown>> };
	partialX.keys[0] = { ...partialX.keys[0], time: FRAME_TICKS };
	partialY.keys[0] = { ...partialY.keys[0], time: FRAME_TICKS };
	assert.throws(() => compile(partial), isPlanError("UNSUPPORTED_TIMELINE"));
});
