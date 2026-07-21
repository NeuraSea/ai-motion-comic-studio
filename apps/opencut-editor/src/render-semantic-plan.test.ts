import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
	canonicalTimelineDocumentFromTracks,
	compileRenderSemanticPlan,
	RENDER_SEMANTIC_SHORT_VIDEO_FILL_STRATEGY,
	renderSemanticPlanBoundarySignature,
	RenderSemanticPlanError,
	shortVideoFillClipId,
	type RenderSemanticAssetBinding,
} from "./index.js";

const FRAME = 5_000;
const checksum = (digit: string): string => digit.repeat(64);

function goldenFixture(): {
	document: ReturnType<typeof canonicalTimelineDocumentFromTracks>;
	assets: RenderSemanticAssetBinding[];
} {
	const document = canonicalTimelineDocumentFromTracks({
		overlay: [
			{
				id: "visuals",
				type: "video",
				elements: [
					{
						id: "portrait-still",
						type: "image",
						mediaId: "asset-still",
						name: "竖屏定场",
						startTime: 0,
						duration: 24 * FRAME,
						trimStart: 0,
						trimEnd: 0,
						params: { fit: "cover", storyShotId: "shot-1" },
					},
					{
						id: "portrait-video",
						type: "video",
						mediaId: "asset-video",
						name: "竖屏视频",
						startTime: 24 * FRAME,
						duration: 48 * FRAME,
						trimStart: 12 * FRAME,
						trimEnd: 12 * FRAME,
						sourceDuration: 72 * FRAME,
						params: { fit: "contain", storyShotId: "shot-2" },
					},
				],
			},
			{
				id: "subtitles",
				type: "text",
				elements: [
					{
						id: "subtitle-a",
						type: "text",
						name: "第一句",
						startTime: 0,
						duration: 24 * FRAME,
						trimStart: 0,
						trimEnd: 0,
						params: { content: "第一句", text: "第一句", manjuRole: "subtitle" },
					},
					{
						id: "subtitle-b",
						type: "text",
						name: "第二句",
						startTime: 24 * FRAME,
						duration: 24 * FRAME,
						trimStart: 0,
						trimEnd: 0,
						params: { content: "第二句", text: "第二句", manjuRole: "subtitle" },
					},
					{
						id: "subtitle-c",
						type: "text",
						name: "第三句",
						startTime: 48 * FRAME,
						duration: 24 * FRAME,
						trimStart: 0,
						trimEnd: 0,
						params: { content: "第三句", text: "第三句", manjuRole: "subtitle" },
					},
				],
			},
		],
		main: { id: "main", type: "video", elements: [] },
		audio: [
			{
				id: "bgm-track",
				type: "audio",
				elements: [{
					id: "bgm",
					type: "audio",
					sourceType: "upload",
					mediaId: "asset-bgm",
					name: "BGM",
					startTime: 0,
					duration: 72 * FRAME,
					trimStart: 24 * FRAME,
					trimEnd: 24 * FRAME,
					sourceDuration: 120 * FRAME,
					params: {
						audioRole: "bgm",
						volume: 0.5,
						fadeInSeconds: 0.5,
						fadeOutSeconds: 0.25,
					},
				}],
			},
			{
				id: "dialogue-track",
				type: "audio",
				elements: [{
					id: "dialogue",
					type: "audio",
					sourceType: "upload",
					mediaId: "asset-dialogue",
					name: "对白",
					startTime: 24 * FRAME,
					duration: 24 * FRAME,
					trimStart: 0,
					trimEnd: 0,
					sourceDuration: 24 * FRAME,
					params: { dialogueLineId: "line-1", volume: 1 },
				}],
			},
		],
	}, { frameRate: { numerator: 24, denominator: 1 } });

	return {
		document,
		assets: [
			{ assetId: "asset-still", version: 3, checksum: checksum("a"), mediaType: "image" },
			{
				assetId: "asset-video",
				version: 5,
				checksum: checksum("b"),
				mediaType: "video",
				sourceDurationFrames: 72,
			},
			{
				assetId: "asset-bgm",
				version: 2,
				checksum: checksum("c"),
				mediaType: "audio",
				sourceDurationFrames: 120,
				audioRole: "bgm",
			},
			{
				assetId: "asset-dialogue",
				version: 7,
				checksum: checksum("d"),
				mediaType: "audio",
				sourceDurationFrames: 24,
				audioRole: "dialogue",
			},
		],
	};
}

function compileGolden() {
	const fixture = goldenFixture();
	return compileRenderSemanticPlan({
		timelineDocument: fixture.document,
		timelineDocumentId: "timeline-document-9x16",
		timelineRevisionId: "timeline-revision-pinned",
		storyRevisionId: "story-revision-pinned",
		aspectRatio: "9:16",
		assets: fixture.assets,
	});
}

test("compiles one immutable 9:16 mixed-media semantic golden", () => {
	const plan = compileGolden();
	assert.equal(plan.timelineRevisionId, "timeline-revision-pinned");
	assert.equal(plan.storyRevisionId, "story-revision-pinned");
	assert.equal(plan.frameRate, 24);
	assert.equal(plan.aspectRatio, "9:16");
	assert.equal(plan.totalFrames, 72);
	assert.deepEqual(plan.visualClips, [
		{
			id: "portrait-still",
			mediaType: "image",
			asset: {
				assetId: "asset-still",
				version: 3,
				checksum: checksum("a"),
				sourceDurationFrames: null,
			},
			startFrame: 0,
			durationFrames: 24,
			endFrameExclusive: 24,
			sourceTrim: null,
			fit: "cover",
		},
		{
			id: "portrait-video",
			mediaType: "video",
			asset: {
				assetId: "asset-video",
				version: 5,
				checksum: checksum("b"),
				sourceDurationFrames: 72,
			},
			startFrame: 24,
			durationFrames: 48,
			endFrameExclusive: 72,
			sourceTrim: {
				startFrame: 12,
				durationFrames: 48,
				endTrimFrames: 12,
				sourceDurationFrames: 72,
			},
			fit: "contain",
		},
	]);
	assert.deepEqual(plan.audioClips.map((clip) => ({
		id: clip.id,
		role: clip.role,
		linearGain: clip.linearGain,
		fadeInSeconds: clip.fadeInSeconds,
		fadeOutSeconds: clip.fadeOutSeconds,
		startFrame: clip.startFrame,
		durationFrames: clip.durationFrames,
		sourceStartFrame: clip.sourceTrim.startFrame,
		duckingWindows: clip.duckingWindows,
	})), [
		{
			id: "bgm",
			role: "bgm",
			linearGain: 0.5,
			fadeInSeconds: 0.5,
			fadeOutSeconds: 0.25,
			startFrame: 0,
			durationFrames: 72,
			sourceStartFrame: 24,
			duckingWindows: [{
				triggerAudioClipIds: ["dialogue"],
				startFrame: 24,
				endFrameExclusive: 48,
				duckedLinearGain: 0.35,
				attackSeconds: 0.12,
				releaseSeconds: 0.12,
			}],
		},
		{
			id: "dialogue",
			role: "dialogue",
			linearGain: 1,
			fadeInSeconds: 0,
			fadeOutSeconds: 0,
			startFrame: 24,
			durationFrames: 24,
			sourceStartFrame: 0,
			duckingWindows: [],
		},
	]);
	assert.deepEqual(plan.subtitleCues.map((cue) => [
		cue.id,
		cue.startFrame,
		cue.endFrameExclusive,
		cue.text,
	]), [
		["subtitle-a", 0, 24, "第一句"],
		["subtitle-b", 24, 48, "第二句"],
		["subtitle-c", 48, 72, "第三句"],
	]);
	assert.equal(Object.isFrozen(plan), true);
	assert.equal(Object.isFrozen(plan.visualClips), true);
	assert.equal(Object.isFrozen(plan.audioClips[0]!.duckingWindows), true);
});

test("boundary-frame signature locks hard cuts, adjacent cues, trim, fade, and dialogue ducking", () => {
	const serializedSignature = renderSemanticPlanBoundarySignature(compileGolden());
	const signature = JSON.parse(serializedSignature) as Array<{
		frame: number;
		visual: Array<{ id: string; sourceFrame: number | null }>;
		audio: Array<{ id: string; effectiveLinearGain: number; ducked: boolean }>;
		subtitles: Array<{ id: string }>;
	}>;
	const at = (frame: number) => signature.find((sample) => sample.frame === frame)!;
	assert.deepEqual(at(23).visual.map((clip) => [clip.id, clip.sourceFrame]), [["portrait-still", null]]);
	assert.deepEqual(at(24).visual.map((clip) => [clip.id, clip.sourceFrame]), [["portrait-video", 12]]);
	assert.deepEqual(at(71).visual.map((clip) => [clip.id, clip.sourceFrame]), [["portrait-video", 59]]);
	assert.deepEqual(at(23).subtitles.map((cue) => cue.id), ["subtitle-a"]);
	assert.deepEqual(at(24).subtitles.map((cue) => cue.id), ["subtitle-b"]);
	assert.deepEqual(at(47).subtitles.map((cue) => cue.id), ["subtitle-b"]);
	assert.deepEqual(at(48).subtitles.map((cue) => cue.id), ["subtitle-c"]);
	assert.equal(at(0).audio.find((clip) => clip.id === "bgm")?.effectiveLinearGain, 0);
	assert.deepEqual(at(24).audio.map((clip) => [clip.id, clip.effectiveLinearGain, clip.ducked]), [
		["bgm", 0.175, true],
		["dialogue", 1, false],
	]);
	assert.deepEqual(at(48).audio.map((clip) => [clip.id, clip.effectiveLinearGain, clip.ducked]), [
		["bgm", 0.175, true],
	]);
	assert.equal(at(51).audio.find((clip) => clip.id === "bgm")?.ducked, false);
	assert.equal(at(71).audio.find((clip) => clip.id === "bgm")?.effectiveLinearGain, 0.083333);

	assert.equal(
		createHash("sha256").update(serializedSignature).digest("hex"),
		"8956fcbfcaa22b4f67ec3b682667a35e7b39ce276ede8a23d4a5a7cb0f27155e",
	);
});

test("expands an explicit short managed video into source video plus same-shot locked image hold", () => {
	const sourceFrames = 72;
	const targetFrames = 120;
	const document = canonicalTimelineDocumentFromTracks({
		overlay: [{
			id: "visuals",
			type: "video",
			elements: [{
				id: "short-shot",
				type: "video",
				mediaId: "short-video",
				name: "Short shot",
				startTime: 0,
				duration: targetFrames * FRAME,
				trimStart: 0,
				trimEnd: 0,
				sourceDuration: sourceFrames * FRAME,
				isSourceAudioEnabled: true,
				params: {
					storySceneId: "scene-1",
					storyShotId: "shot-1",
					sourceRevisionId: "story-revision",
					audioRole: "sfx",
				},
				manju: {
					shortVideoFill: {
						version: 1,
						strategy: RENDER_SEMANTIC_SHORT_VIDEO_FILL_STRATEGY,
						fallbackAssetId: "same-shot-storyboard",
						storySceneId: "scene-1",
						storyShotId: "shot-1",
						sourceRevisionId: "story-revision",
						sourceDurationTicks: sourceFrames * FRAME,
						targetDurationTicks: targetFrames * FRAME,
						appliedByOpenCut: true,
						appliedPlanHash: checksum("f"),
					},
				},
			}],
		}],
		main: { id: "main", type: "video", elements: [] },
		audio: [],
	});
	const plan = compileRenderSemanticPlan({
		timelineDocument: document,
		timelineDocumentId: "doc",
		timelineRevisionId: "timeline-revision",
		storyRevisionId: "story-revision",
		aspectRatio: "16:9",
		assets: [{
			assetId: "short-video",
			version: 2,
			checksum: checksum("a"),
			mediaType: "video",
			sourceDurationFrames: sourceFrames,
			audioRole: "sfx",
		}, {
			assetId: "same-shot-storyboard",
			version: 4,
			checksum: checksum("b"),
			mediaType: "image",
		}],
	});

	assert.equal(plan.totalFrames, targetFrames);
	assert.deepEqual(plan.visualClips.map((clip) => ({
		id: clip.id,
		mediaType: clip.mediaType,
		assetId: clip.asset.assetId,
		startFrame: clip.startFrame,
		durationFrames: clip.durationFrames,
		sourceDurationFrames: clip.sourceTrim?.durationFrames ?? null,
	})), [{
		id: "short-shot",
		mediaType: "video",
		assetId: "short-video",
		startFrame: 0,
		durationFrames: sourceFrames,
		sourceDurationFrames: sourceFrames,
	}, {
		id: shortVideoFillClipId("short-shot"),
		mediaType: "image",
		assetId: "same-shot-storyboard",
		startFrame: sourceFrames,
		durationFrames: targetFrames - sourceFrames,
		sourceDurationFrames: null,
	}]);
	assert.deepEqual(plan.audioClips.map((clip) => ({
		id: clip.id,
		durationFrames: clip.durationFrames,
	})), [{ id: "short-shot:source-audio", durationFrames: sourceFrames }]);

	const pending = structuredClone(document);
	const pendingFill = pending.tracks.overlay[0]!.elements[0]!.manju!
		.shortVideoFill as Record<string, unknown>;
	pendingFill.appliedByOpenCut = false;
	pendingFill.appliedPlanHash = null;
	assert.throws(
		() => compileRenderSemanticPlan({
			timelineDocument: pending,
			timelineDocumentId: "doc",
			timelineRevisionId: "timeline-revision",
			storyRevisionId: "story-revision",
			aspectRatio: "16:9",
			assets: [{
				assetId: "short-video", version: 2, checksum: checksum("a"),
				mediaType: "video", sourceDurationFrames: sourceFrames, audioRole: "sfx",
			}, {
				assetId: "same-shot-storyboard", version: 4, checksum: checksum("b"),
				mediaType: "image",
			}],
		}),
		(error: unknown) => error instanceof RenderSemanticPlanError
			&& error.message.includes("pending the audited OpenCut atomic edit"),
	);

	const missingProvenance = structuredClone(document);
	delete missingProvenance.tracks.overlay[0]!.elements[0]!.manju;
	assert.throws(
		() => compileRenderSemanticPlan({
			timelineDocument: missingProvenance,
			timelineDocumentId: "doc",
			timelineRevisionId: "timeline-revision",
			storyRevisionId: "story-revision",
			aspectRatio: "16:9",
			assets: [{
				assetId: "short-video",
				version: 2,
				checksum: checksum("a"),
				mediaType: "video",
				sourceDurationFrames: sourceFrames,
				audioRole: "sfx",
			}],
		}),
		(error: unknown) => error instanceof RenderSemanticPlanError
			&& error.message.includes("trimStart + duration + trimEnd"),
	);
});

test("fails closed on unsupported params, ambiguous audio roles, and non-frame-aligned edits", () => {
	const unsupported = goldenFixture();
	const visual = unsupported.document.tracks.overlay[0]!.elements[0]!;
	visual.params.rotation = 15;
	assert.throws(
		() => compileRenderSemanticPlan({
			timelineDocument: unsupported.document,
			timelineDocumentId: "doc",
			timelineRevisionId: "timeline-revision",
			storyRevisionId: "story-revision",
			aspectRatio: "9:16",
			assets: unsupported.assets,
		}),
		(error: unknown) => error instanceof RenderSemanticPlanError
			&& error.code === "UNSUPPORTED_TIMELINE"
			&& error.path.endsWith("params.rotation"),
	);

	const ambiguous = goldenFixture();
	const bgm = ambiguous.document.tracks.audio[0]!.elements[0]!;
	delete bgm.params.audioRole;
	ambiguous.assets = ambiguous.assets.map((asset) => asset.assetId === "asset-bgm"
		? { ...asset, audioRole: undefined }
		: asset);
	assert.throws(
		() => compileRenderSemanticPlan({
			timelineDocument: ambiguous.document,
			timelineDocumentId: "doc",
			timelineRevisionId: "timeline-revision",
			storyRevisionId: "story-revision",
			aspectRatio: "9:16",
			assets: ambiguous.assets,
		}),
		(error: unknown) => error instanceof RenderSemanticPlanError
			&& error.code === "INVALID_TIMELINE"
			&& /ambiguous/.test(error.message),
	);

	const offFrame = goldenFixture();
	offFrame.document.tracks.overlay[0]!.elements[1]!.trimStart += 1;
	assert.throws(
		() => compileRenderSemanticPlan({
			timelineDocument: offFrame.document,
			timelineDocumentId: "doc",
			timelineRevisionId: "timeline-revision",
			storyRevisionId: "story-revision",
			aspectRatio: "9:16",
			assets: offFrame.assets,
		}),
		(error: unknown) => error instanceof RenderSemanticPlanError
			&& error.code === "INVALID_TIMELINE"
			&& /24 fps frame boundary/.test(error.message),
	);
});
