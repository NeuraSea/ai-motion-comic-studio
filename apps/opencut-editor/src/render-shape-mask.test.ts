import assert from "node:assert/strict";
import test from "node:test";

import {
	canonicalTimelineDocumentFromTracks,
	compileRenderSemanticPlan,
	compileRenderSemanticVisualShapeMask,
	renderSemanticPlanBoundarySignature,
	renderSemanticVisualShapeMaskGeometry,
	RenderSemanticPlanError,
} from "./index.js";

const FRAME_TICKS = 5_000;

function shapeMask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "mask-1",
		type: "ellipse",
		params: {
			feather: 0,
			inverted: false,
			strokeColor: "#ffffff",
			strokeWidth: 0,
			strokeAlign: "center",
			centerX: 0.1,
			centerY: -0.2,
			width: 0.5,
			height: 0.4,
			rotation: 0,
			scale: 1,
			...overrides,
		},
	};
}

function compile(mask: Record<string, unknown>) {
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
				duration: 24 * FRAME_TICKS,
				trimStart: 0,
				trimEnd: 0,
				params: { fit: "cover" },
				masks: [mask],
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
		assets: [{
			assetId: "image",
			version: 1,
			checksum: "a".repeat(64),
			mediaType: "image",
		}],
	});
}

test("compiles one pinned OpenCut ellipse mask into RSP v5 geometry", () => {
	const plan = compile(shapeMask());
	assert.equal(plan.version, 5);
	const mask = plan.visualClips[0]!.shapeMask;
	assert.deepEqual(mask, {
		version: 2,
		type: "ellipse",
		inverted: false,
		centerX: 0.1,
		centerY: -0.2,
		width: 0.5,
		height: 0.4,
	});
	assert.ok(Object.isFrozen(mask));
	assert.deepEqual(renderSemanticVisualShapeMaskGeometry(mask!, 1_280, 720), {
		centerX: 768,
		centerY: 216,
		width: 640,
		height: 288,
	});
	const signature = JSON.parse(renderSemanticPlanBoundarySignature(plan)) as Array<{
		visual: Array<{ shapeMask?: unknown }>;
	}>;
	assert.deepEqual(signature[0]!.visual[0]!.shapeMask, mask);
});

test("accepts the audited rectangle subset and canonicalizes numeric precision", () => {
	assert.deepEqual(compileRenderSemanticVisualShapeMask({
		masks: [{ ...shapeMask({ centerX: -0, width: 0.333333333 }), type: "rectangle" }],
	}), {
		version: 2,
		type: "rectangle",
		inverted: false,
		centerX: 0,
		centerY: -0.2,
		width: 0.333333,
		height: 0.4,
	});
});

test("compiles inverted polarity without changing the pinned canvas geometry", () => {
	const plan = compile(shapeMask({ inverted: true }));
	const mask = plan.visualClips[0]!.shapeMask;
	assert.deepEqual(mask, {
		version: 2,
		type: "ellipse",
		inverted: true,
		centerX: 0.1,
		centerY: -0.2,
		width: 0.5,
		height: 0.4,
	});
	assert.deepEqual(renderSemanticVisualShapeMaskGeometry(mask!, 1_280, 720), {
		centerX: 768,
		centerY: 216,
		width: 640,
		height: 288,
	});
	const signature = JSON.parse(renderSemanticPlanBoundarySignature(plan)) as Array<{
		visual: Array<{ shapeMask?: { inverted?: boolean } }>;
	}>;
	assert.equal(signature[0]!.visual[0]!.shapeMask?.inverted, true);
});

test("fails closed for feather, rotation, stroke, scale, unknown and multiple masks", () => {
	const invalid = [
		shapeMask({ feather: 0.1 }),
		shapeMask({ rotation: 30 }),
		shapeMask({ strokeWidth: 1 }),
		shapeMask({ scale: 2 }),
		{ ...shapeMask(), type: "heart" },
	];
	for (const mask of invalid) {
		assert.throws(
			() => compile(mask),
			(error: unknown) => error instanceof RenderSemanticPlanError
				&& error.code === "UNSUPPORTED_TIMELINE",
		);
	}
	assert.throws(
		() => compileRenderSemanticVisualShapeMask({ masks: [shapeMask(), shapeMask()] }),
		(error: unknown) => error instanceof RenderSemanticPlanError
			&& error.code === "UNSUPPORTED_TIMELINE",
	);
	assert.throws(
		() => compileRenderSemanticVisualShapeMask({
			masks: { length: 0 } as unknown as Record<string, unknown>[],
		}),
		(error: unknown) => error instanceof RenderSemanticPlanError
			&& error.code === "INVALID_TIMELINE",
	);
	assert.throws(
		() => compile(shapeMask({ inverted: "true" })),
		(error: unknown) => error instanceof RenderSemanticPlanError
			&& error.code === "INVALID_TIMELINE"
			&& error.path.endsWith("params.inverted"),
	);
});
