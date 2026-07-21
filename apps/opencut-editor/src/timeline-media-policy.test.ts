import assert from "node:assert/strict";
import test from "node:test";

import {
	classifyTimelineAssetScope,
	projectTimelineMediaParticipation,
} from "./timeline-media-policy.js";

test("projects pinned OpenCut hidden, muted, and source-audio flags", () => {
	const video = { type: "video", isSourceAudioEnabled: true };
	assert.deepEqual(
		projectTimelineMediaParticipation(
			{ type: "video", hidden: false, muted: false },
			video,
		),
		{ visual: true, timelineAudio: false, sourceAudio: true },
	);
	assert.deepEqual(
		projectTimelineMediaParticipation(
			{ type: "video", hidden: false, muted: true },
			video,
		),
		{ visual: true, timelineAudio: false, sourceAudio: false },
	);
	assert.deepEqual(
		projectTimelineMediaParticipation(
			{ type: "audio", muted: true },
			{ type: "audio" },
		),
		{ visual: false, timelineAudio: false, sourceAudio: false },
	);
	assert.deepEqual(
		projectTimelineMediaParticipation(
			{ type: "video", hidden: false, muted: false },
			{ ...video, hidden: true },
		),
		{ visual: false, timelineAudio: false, sourceAudio: false },
	);
});

test("allows project-global assets only for canonical media identity", () => {
	const scope = { projectId: "project-1", episodeId: "episode-1" };
	const global = { projectId: "project-1", episodeId: null };
	assert.equal(classifyTimelineAssetScope(global, scope, true), "allowed");
	assert.equal(classifyTimelineAssetScope(global, scope, false), "episode-mismatch");
	assert.equal(
		classifyTimelineAssetScope({ projectId: "project-2", episodeId: null }, scope),
		"project-mismatch",
	);
});
