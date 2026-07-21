import assert from "node:assert/strict";
import test from "node:test";
import {
	CANONICAL_TIMELINE_DOCUMENT_VERSION,
	OPEN_CUT_TIMELINE_TYPES_UPSTREAM_SHA256,
	canonicalTimelineDocumentFromTracks,
	canonicalizeOpenCutTimelineDocument,
	parseCanonicalTimelineDocument,
	serializeCanonicalTimelineDocument,
} from "./canonical-timeline-codec.js";
import {
	OPEN_CUT_CLASSIC_COMMIT,
	OPEN_CUT_TICKS_PER_SECOND,
} from "./opencut-timeline-engine.js";

const SECOND = 120_000;

function legacyDocument() {
	return {
		version: 1,
		editor: "OpenCut-Classic",
		upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
		ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
		frameRate: { numerator: 24, denominator: 1 },
		tracks: {
			overlay: [
				{
					id: "visuals",
					type: "video",
					elements: [
						{
							id: "image-1",
							type: "image",
							startTime: 0,
							duration: SECOND,
							params: {
								assetId: "asset-image-1",
								storyShotId: "shot-1",
								legacyLayout: { crop: "cover" },
							},
						},
					],
				},
			],
			main: { id: "main", type: "video", elements: [] },
			audio: [
				{
					id: "dialogue",
					type: "audio",
					elements: [
						{
							id: "audio-1",
							type: "audio",
							name: "对白",
							startTime: 0,
							duration: SECOND,
							trimStart: 0,
							trimEnd: 0,
							params: {
								assetId: "asset-audio-1",
								storyDialogueId: "dialogue-1",
							},
						},
					],
				},
			],
		},
	};
}

test("migrates v1 asset aliases into pinned OpenCut discriminated-union fields", () => {
	const result = canonicalizeOpenCutTimelineDocument(legacyDocument());
	assert.equal(result.migratedFromVersion, 1);
	assert.equal(result.document.version, CANONICAL_TIMELINE_DOCUMENT_VERSION);

	const visualTrack = result.document.tracks.overlay[0];
	const image = visualTrack?.elements[0];
	assert.equal(visualTrack?.name, "visuals");
	assert.equal(visualTrack?.hidden, false);
	assert.equal(visualTrack?.type === "video" && visualTrack.muted, false);
	assert.equal(image?.type, "image");
	assert.equal(image?.name, "image-1");
	assert.equal(image?.trimStart, 0);
	assert.equal(image?.trimEnd, 0);
	assert.equal(image?.type === "image" && image.mediaId, "asset-image-1");
	assert.equal(image?.params.assetId, undefined);
	assert.equal(image?.params.storyShotId, "shot-1");
	assert.deepEqual(image?.manju?.legacyParams, {
		legacyLayout: { crop: "cover" },
	});

	const audioTrack = result.document.tracks.audio[0];
	const audio = audioTrack?.elements[0];
	assert.equal(audioTrack?.name, "dialogue");
	assert.equal(audioTrack?.muted, false);
	assert.equal(audio?.type === "audio" && audio.sourceType, "upload");
	assert.equal(
		audio?.type === "audio" && audio.sourceType === "upload" && audio.mediaId,
		"asset-audio-1",
	);
	assert.equal(audio?.params.assetId, undefined);
	assert.equal(result.document.tracks.main.name, "main");
	assert.equal(result.document.tracks.main.hidden, false);
	assert.equal(result.document.tracks.main.muted, false);
});

test("marks a legacy Manju visual with no ready asset as an explicit unresolved binding", () => {
	const legacy = legacyDocument();
	const image = legacy.tracks.overlay[0]!.elements[0]!;
	delete (image.params as { assetId?: string }).assetId;

	const migrated = parseCanonicalTimelineDocument(legacy);
	const element = migrated.tracks.overlay[0]!.elements[0]!;
	assert.equal(element.type === "image" && element.mediaId, "manju:pending:image-1");
	assert.equal(element.manju?.mediaBindingState, "unresolved");
});

test("restores durable Story IDs from the ordered v1 Manju shot manifest", () => {
	const legacy = legacyDocument();
	const image = legacy.tracks.overlay[0]!.elements[0]!;
	(image as unknown as { params: Record<string, unknown> }).params = { shotId: "1" };
	Object.assign(legacy, {
		manjuTimeline: {
			adapterVersion: 1,
			storyShots: [{ sceneId: "scene-durable", shotId: "shot-durable" }],
		},
	});

	const migrated = parseCanonicalTimelineDocument(legacy);
	const element = migrated.tracks.overlay[0]!.elements[0]!;
	assert.equal(element.type === "image" && element.mediaId, "manju:pending:image-1");
	assert.equal(element.params.shotId, "1");
	assert.equal(element.params.storySceneId, "scene-durable");
	assert.equal(element.params.storyShotId, "shot-durable");
	assert.equal(element.manju?.mediaBindingState, "unresolved");
});

test("does not guess an out-of-range local shot number during v1 migration", () => {
	const legacy = legacyDocument();
	const image = legacy.tracks.overlay[0]!.elements[0]!;
	(image as unknown as { params: Record<string, unknown> }).params = { shotId: "2" };
	Object.assign(legacy, {
		manjuTimeline: {
			adapterVersion: 1,
			storyShots: [{ sceneId: "scene-durable", shotId: "shot-durable" }],
		},
	});

	assert.throws(
		() => parseCanonicalTimelineDocument(legacy),
		/legacy visual element has neither mediaId nor params\.assetId/,
	);
});

test("keeps an orphaned legacy upload-audio element valid with an unresolved mediaId", () => {
	const legacy = legacyDocument();
	const audio = legacy.tracks.audio[0]!.elements[0]!;
	delete (audio.params as { assetId?: string }).assetId;

	const migrated = parseCanonicalTimelineDocument(legacy);
	const element = migrated.tracks.audio[0]!.elements[0]!;
	assert.equal(element.type === "audio" && element.sourceType, "upload");
	assert.equal(
		element.type === "audio" && element.sourceType === "upload" && element.mediaId,
		"manju:pending:audio-1",
	);
	assert.equal(element.manju?.mediaBindingState, "unresolved");
});

test("strict v2 validation does not allow Manju metadata to substitute union fields", () => {
	const canonical = parseCanonicalTimelineDocument(legacyDocument());
	const image = canonical.tracks.overlay[0]!.elements[0]!;
	assert.equal(image.type, "image");
	delete (image as { mediaId?: string }).mediaId;
	image.manju = { mediaId: "asset-in-the-wrong-namespace" };

	assert.throws(
		() => parseCanonicalTimelineDocument(canonical),
		/error|mediaId: must be a non-empty string/i,
	);
});

test("strict v2 validation enforces audio source and required track flags", () => {
	const canonical = parseCanonicalTimelineDocument(legacyDocument());
	const audio = canonical.tracks.audio[0]!.elements[0]!;
	delete (audio as { sourceType?: string }).sourceType;
	assert.throws(
		() => parseCanonicalTimelineDocument(canonical),
		/sourceType: must be upload or library/,
	);

	const missingFlag = parseCanonicalTimelineDocument(legacyDocument());
	delete (missingFlag.tracks.main as { hidden?: boolean }).hidden;
	assert.throws(
		() => parseCanonicalTimelineDocument(missingFlag),
		/tracks\.main\.hidden: must be a boolean/,
	);
});

test("strict v2 keeps upload and library audio source fields mutually exclusive", () => {
	const upload = parseCanonicalTimelineDocument(legacyDocument());
	const uploadAudio = upload.tracks.audio[0]!.elements[0]!;
	assert.equal(uploadAudio.type, "audio");
	(uploadAudio as { sourceUrl?: string }).sourceUrl =
		"https://library.invalid/audio.mp3";
	assert.throws(
		() => parseCanonicalTimelineDocument(upload),
		/sourceUrl: must be absent for upload audio/,
	);

	const library = parseCanonicalTimelineDocument(legacyDocument());
	const libraryAudio = library.tracks.audio[0]!.elements[0]!;
	assert.equal(libraryAudio.type, "audio");
	Object.assign(libraryAudio, {
		sourceType: "library",
		sourceUrl: "https://library.invalid/audio.mp3",
		mediaId: "must-not-win",
	});
	assert.throws(
		() => parseCanonicalTimelineDocument(library),
		/mediaId: must be absent for library audio/,
	);
});

test("strict v2 validation rejects duplicate IDs and nested ParamValues", () => {
	const duplicate = parseCanonicalTimelineDocument(legacyDocument());
	duplicate.tracks.main.id = duplicate.tracks.overlay[0]!.id;
	assert.throws(
		() => parseCanonicalTimelineDocument(duplicate),
		/duplicate track id visuals/,
	);

	const nestedParams = parseCanonicalTimelineDocument(legacyDocument());
	const image = nestedParams.tracks.overlay[0]!.elements[0]!;
	(image.params as Record<string, unknown>).nested = { unsafe: true };
	assert.throws(
		() => parseCanonicalTimelineDocument(nestedParams),
		/ParamValues must be string, number, or boolean/,
	);
});

test("strict v2 rejects legacy params.assetId even when mediaId is present", () => {
	const canonical = parseCanonicalTimelineDocument(legacyDocument());
	const image = canonical.tracks.overlay[0]!.elements[0]!;
	(image.params as Record<string, unknown>).assetId = "shadow-binding";
	assert.throws(
		() => parseCanonicalTimelineDocument(canonical),
		/legacy asset alias is forbidden/,
	);
});

test("v2 parse and serialization retain namespaced and forward-compatible JSON fields", () => {
	const canonical = parseCanonicalTimelineDocument(legacyDocument()) as unknown as Record<
		string,
		unknown
	>;
	canonical.forwardCompatibleRoot = { revision: 3 };
	const tracks = canonical.tracks as {
		overlay: Array<Record<string, unknown>>;
	};
	tracks.overlay[0]!.forwardCompatibleTrack = ["kept"];
	const elements = tracks.overlay[0]!.elements as Array<Record<string, unknown>>;
	elements[0]!.forwardCompatibleElement = { kept: true };

	const parsed = parseCanonicalTimelineDocument(canonical);
	const reparsed = parseCanonicalTimelineDocument(
		JSON.parse(serializeCanonicalTimelineDocument(parsed)),
	);
	assert.deepEqual(reparsed, parsed);
});

test("track snapshots use the same migration path and pinned provenance", () => {
	const legacy = legacyDocument();
	const document = canonicalTimelineDocumentFromTracks(legacy.tracks, {
		frameRate: legacy.frameRate,
		manju: { projectId: "project-1" },
	});
	assert.equal(document.version, 2);
	assert.equal(document.upstreamCommit, OPEN_CUT_CLASSIC_COMMIT);
	assert.equal(document.tracks.overlay[0]!.elements[0]!.type, "image");
	assert.equal(
		OPEN_CUT_TIMELINE_TYPES_UPSTREAM_SHA256,
		"9ed9fbd54de1a9c7b27a98f833db712ee32dd0106c73a87be5ed466def8958ac",
	);
});
