import type { ElementAnimations } from "../../../third_party/OpenCut-Classic/src/animation/types.js";
import {
	Command,
	type CommandResult,
} from "../../../third_party/OpenCut-Classic/src/commands/base-command.js";
import { DeleteElementsCommand } from "../../../third_party/OpenCut-Classic/src/commands/timeline/element/delete-elements.js";
import { InsertElementCommand } from "../../../third_party/OpenCut-Classic/src/commands/timeline/element/insert-element.js";
import { MoveElementCommand } from "../../../third_party/OpenCut-Classic/src/commands/timeline/element/move-elements.js";
import { SplitElementsCommand } from "../../../third_party/OpenCut-Classic/src/commands/timeline/element/split-elements.js";
import { UpdateElementsCommand } from "../../../third_party/OpenCut-Classic/src/commands/timeline/element/update-elements.js";
import { AddTrackCommand } from "../../../third_party/OpenCut-Classic/src/commands/timeline/track/add-track.js";
import { CommandManager } from "../../../third_party/OpenCut-Classic/src/core/managers/commands.js";
import { EditorCore } from "../../../third_party/OpenCut-Classic/src/ports/editor-core.js";
import { mediaTime } from "../../../third_party/OpenCut-Classic/src/ports/media-time.js";
import type {
	CreateTimelineElement,
	SceneTracks,
	TimelineElement,
} from "../../../third_party/OpenCut-Classic/src/ports/timeline.js";
import { generateUUID } from "../../../third_party/OpenCut-Classic/src/utils/id.js";
import { buildMoveGroup } from "../../../third_party/OpenCut-Classic/src/timeline/group-move/build-group.js";
import { resolveGroupMove } from "../../../third_party/OpenCut-Classic/src/timeline/group-move/resolve-move.js";
import {
	buildResizeMembers,
	hasResizeChanges,
} from "../../../third_party/OpenCut-Classic/src/timeline/group-resize/build-members.js";
import { computeGroupResize } from "../../../third_party/OpenCut-Classic/src/timeline/group-resize/compute-resize.js";
import type {
	AddElementDecision,
	AddElementInput,
	AddTrackDecision,
	AddTrackInput,
	CommitElementMovesInput,
	CommitElementPropertyUpdatesInput,
	CommitElementUpdatesInput,
	DeleteElementsInput,
	EditorCreateTimelineElement,
	EditorElementRef,
	EditorSceneTracks,
	EditorTimelineElement,
	ManagedSubtitleCueInput,
	ManagedSubtitleCueProvenance,
	ManagedSubtitleCueSetProvenance,
	ManagedSubtitleCueSetSnapshot,
	ManagedSubtitleCueSetStaleReason,
	MoveElementsDecision,
	MoveElementsInput,
	OpenCutCommandEditor,
	OpenCutEditorSelectionSnapshot,
	OpenCutPlaybackController,
	OpenCutPlaybackSnapshot,
	ResizeElementsDecision,
	ResizeElementsInput,
	ReplaceManagedSubtitleCueSetInput,
	SplitElementsDecision,
	SplitElementsInput,
} from "./contracts.js";
import {
	OPEN_CUT_CLASSIC_COMMIT,
	OPEN_CUT_TICKS_PER_SECOND,
} from "./opencut-timeline-engine.js";

const MANAGED_SUBTITLE_TRACK_ID = "manju-managed-speech-subtitles";
const MANAGED_SUBTITLE_TRACK_NAME = "对白字幕（托管）";
const MANAGED_SUBTITLE_ROLE = "speech-subtitle";
const MANAGED_SUBTITLE_VERSION = 1 as const;
const FIXED_FRAME_RATE = 24;
const FRAME_TICKS = OPEN_CUT_TICKS_PER_SECOND / FIXED_FRAME_RATE;
const MAX_SUBTITLE_CUES = 2_000;
const MAX_CUE_TEXT_CODE_POINTS = 1_000;
const MAX_TOTAL_CUE_TEXT_CODE_POINTS = 20_000;
const MAX_SOURCE_TIMESTAMP_MS = 60 * 60 * 1_000;
const MAX_SOURCE_DURATION_TICKS =
	(MAX_SOURCE_TIMESTAMP_MS * OPEN_CUT_TICKS_PER_SECOND) / 1_000;
const MAX_TIMELINE_TICKS = OPEN_CUT_TICKS_PER_SECOND * 60 * 60 * 24;

const REPLACE_INPUT_KEYS = [
	"cueSetId",
	"dialogueLineId",
	"storySceneId",
	"storyShotId",
	"speechAssetId",
	"sourceAudioElementId",
	"sourceAudioStartTime",
	"sourceAudioTrimStart",
	"sourceAudioDuration",
	"cues",
] as const;

const CUE_INPUT_KEYS = [
	"text",
	"startTime",
	"duration",
	"sourceStartMs",
	"sourceEndMs",
] as const;

const SUBTITLE_CUE_WIRE_KEYS = [
	"version",
	"cueSetId",
	"dialogueLineId",
	"storySceneId",
	"storyShotId",
	"speechAssetId",
	"sourceAudioElementId",
	"sourceCueIndex",
	"sourceStartMs",
	"sourceEndMs",
	"sourceAudioStartTime",
	"sourceAudioTrimStart",
	"sourceAudioDuration",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function assertExactKeys(
	value: unknown,
	keys: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value) || !hasExactKeys(value, keys)) {
		throw new TypeError(`${label} has an invalid shape`);
	}
}

function isSafeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/\p{Cc}/u.test(value)
	);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
	if (!isSafeIdentifier(value)) {
		throw new TypeError(`${label} must be a non-empty safe identifier`);
	}
}

function assertSafeIntegerInRange(
	value: unknown,
	label: string,
	minimum: number,
	maximum: number,
): asserts value is number {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < minimum ||
		(value as number) > maximum
	) {
		throw new RangeError(`${label} is outside the supported range`);
	}
}

function normalizedCueText(value: unknown): string {
	if (typeof value !== "string") {
		throw new TypeError("subtitle cue text must be a string");
	}
	const text = value.replace(/\r\n?/g, "\n").trim();
	if (
		text.length === 0 ||
		[...text].length > MAX_CUE_TEXT_CODE_POINTS ||
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
	) {
		throw new TypeError("subtitle cue text is empty or invalid");
	}
	return text;
}

function validateAndNormalizeSubtitleInput(
	input: ReplaceManagedSubtitleCueSetInput,
): ReplaceManagedSubtitleCueSetInput {
	assertExactKeys(input, REPLACE_INPUT_KEYS, "managed subtitle cue set");
	assertIdentifier(input.cueSetId, "cueSetId");
	assertIdentifier(input.dialogueLineId, "dialogueLineId");
	assertIdentifier(input.storySceneId, "storySceneId");
	assertIdentifier(input.storyShotId, "storyShotId");
	assertIdentifier(input.speechAssetId, "speechAssetId");
	assertIdentifier(input.sourceAudioElementId, "sourceAudioElementId");
	assertSafeIntegerInRange(
		input.sourceAudioStartTime,
		"sourceAudioStartTime",
		0,
		MAX_TIMELINE_TICKS,
	);
	assertSafeIntegerInRange(
		input.sourceAudioTrimStart,
		"sourceAudioTrimStart",
		0,
		MAX_SOURCE_DURATION_TICKS,
	);
	assertSafeIntegerInRange(
		input.sourceAudioDuration,
		"sourceAudioDuration",
		1,
		MAX_SOURCE_DURATION_TICKS,
	);
	if (
		input.sourceAudioStartTime + input.sourceAudioDuration >
		MAX_TIMELINE_TICKS
	) {
		throw new RangeError("source audio visible range exceeds the timeline bound");
	}
	if (
		input.sourceAudioTrimStart + input.sourceAudioDuration >
		MAX_SOURCE_DURATION_TICKS
	) {
		throw new RangeError("source audio trim range exceeds the source bound");
	}
	if (
		input.sourceAudioStartTime % FRAME_TICKS !== 0 ||
		input.sourceAudioDuration % FRAME_TICKS !== 0
	) {
		throw new RangeError("source audio is not aligned to a 24fps frame");
	}
	if (
		!Array.isArray(input.cues) ||
		input.cues.length === 0 ||
		input.cues.length > MAX_SUBTITLE_CUES
	) {
		throw new RangeError("managed subtitle cue set must contain 1..2000 cues");
	}

	let previousEndTime = input.sourceAudioStartTime;
	let previousSourceEndMs = 0;
	let totalTextCodePoints = 0;
	const visibleEndTime =
		input.sourceAudioStartTime + input.sourceAudioDuration;
	const visibleSourceStartScaled = input.sourceAudioTrimStart * 1_000;
	const visibleSourceEndScaled =
		(input.sourceAudioTrimStart + input.sourceAudioDuration) * 1_000;
	const audioDurationFrames = input.sourceAudioDuration / FRAME_TICKS;
	const trimStartMs =
		(input.sourceAudioTrimStart * 1_000) / OPEN_CUT_TICKS_PER_SECOND;
	const visibleDurationMs =
		(input.sourceAudioDuration * 1_000) / OPEN_CUT_TICKS_PER_SECOND;
	const cues = input.cues.map((cue, index): ManagedSubtitleCueInput => {
		assertExactKeys(cue, CUE_INPUT_KEYS, `managed subtitle cue ${index}`);
		const text = normalizedCueText(cue.text);
		assertSafeIntegerInRange(
			cue.startTime,
			`cues[${index}].startTime`,
			0,
			MAX_TIMELINE_TICKS,
		);
		assertSafeIntegerInRange(
			cue.duration,
			`cues[${index}].duration`,
			1,
			MAX_SOURCE_DURATION_TICKS,
		);
		assertSafeIntegerInRange(
			cue.sourceStartMs,
			`cues[${index}].sourceStartMs`,
			0,
			MAX_SOURCE_TIMESTAMP_MS,
		);
		assertSafeIntegerInRange(
			cue.sourceEndMs,
			`cues[${index}].sourceEndMs`,
			1,
			MAX_SOURCE_TIMESTAMP_MS,
		);
		if (cue.startTime % FRAME_TICKS !== 0 || cue.duration % FRAME_TICKS !== 0) {
			throw new RangeError(`cues[${index}] is not aligned to a 24fps frame`);
		}
		const endTime = cue.startTime + cue.duration;
		if (
			cue.startTime < input.sourceAudioStartTime ||
			endTime > visibleEndTime
		) {
			throw new RangeError(`cues[${index}] is outside the visible audio range`);
		}
		if (cue.startTime < previousEndTime) {
			throw new RangeError(`cues[${index}] overlaps the previous cue`);
		}
		if (
			cue.sourceStartMs < previousSourceEndMs ||
			cue.sourceEndMs <= cue.sourceStartMs
		) {
			throw new RangeError(`cues[${index}] has an invalid source interval`);
		}
		const sourceStartScaled =
			cue.sourceStartMs * OPEN_CUT_TICKS_PER_SECOND;
		const sourceEndScaled = cue.sourceEndMs * OPEN_CUT_TICKS_PER_SECOND;
		if (
			sourceStartScaled < visibleSourceStartScaled ||
			sourceEndScaled > visibleSourceEndScaled
		) {
			throw new RangeError(
				`cues[${index}] is outside the visible source audio range`,
			);
		}
		const relativeStartMs = Math.max(0, cue.sourceStartMs - trimStartMs);
		const relativeEndMs = Math.min(
			visibleDurationMs,
			cue.sourceEndMs - trimStartMs,
		);
		const relativeStartFrame = Math.max(
			0,
			Math.min(
				audioDurationFrames,
				Math.round((relativeStartMs * FIXED_FRAME_RATE) / 1_000),
			),
		);
		let relativeEndFrame = Math.max(
			0,
			Math.min(
				audioDurationFrames,
				Math.round((relativeEndMs * FIXED_FRAME_RATE) / 1_000),
			),
		);
		if (
			relativeEndFrame <= relativeStartFrame &&
			relativeStartFrame < audioDurationFrames
		) {
			relativeEndFrame = relativeStartFrame + 1;
		}
		const expectedStartTime =
			input.sourceAudioStartTime + relativeStartFrame * FRAME_TICKS;
		const expectedDuration =
			(relativeEndFrame - relativeStartFrame) * FRAME_TICKS;
		if (
			cue.startTime !== expectedStartTime ||
			cue.duration !== expectedDuration
		) {
			throw new RangeError(
				`cues[${index}] is not the canonical 24fps projection of its source interval`,
			);
		}
		previousEndTime = endTime;
		previousSourceEndMs = cue.sourceEndMs;
		totalTextCodePoints += [...text].length;
		if (totalTextCodePoints > MAX_TOTAL_CUE_TEXT_CODE_POINTS) {
			throw new RangeError("managed subtitle cue text total exceeds 20000 chars");
		}
		return {
			text,
			startTime: cue.startTime,
			duration: cue.duration,
			sourceStartMs: cue.sourceStartMs,
			sourceEndMs: cue.sourceEndMs,
		};
	});

	return {
		cueSetId: input.cueSetId,
		dialogueLineId: input.dialogueLineId,
		storySceneId: input.storySceneId,
		storyShotId: input.storyShotId,
		speechAssetId: input.speechAssetId,
		sourceAudioElementId: input.sourceAudioElementId,
		sourceAudioStartTime: input.sourceAudioStartTime,
		sourceAudioTrimStart: input.sourceAudioTrimStart,
		sourceAudioDuration: input.sourceAudioDuration,
		cues,
	};
}

function parseSubtitleCueProvenance(
	element: EditorTimelineElement,
): ManagedSubtitleCueProvenance | null {
	if (element.type !== "text" || !isRecord(element.manju)) {
		return null;
	}
	const value = element.manju.subtitleCue;
	if (!isRecord(value) || !hasExactKeys(value, SUBTITLE_CUE_WIRE_KEYS)) {
		return null;
	}
	if (
		value.version !== MANAGED_SUBTITLE_VERSION ||
		!isSafeIdentifier(value.cueSetId) ||
		!isSafeIdentifier(value.dialogueLineId) ||
		!isSafeIdentifier(value.storySceneId) ||
		!isSafeIdentifier(value.storyShotId) ||
		!isSafeIdentifier(value.speechAssetId) ||
		!isSafeIdentifier(value.sourceAudioElementId) ||
		!Number.isSafeInteger(value.sourceCueIndex) ||
		(value.sourceCueIndex as number) < 0 ||
		!Number.isSafeInteger(value.sourceStartMs) ||
		(value.sourceStartMs as number) < 0 ||
		!Number.isSafeInteger(value.sourceEndMs) ||
		(value.sourceEndMs as number) <= (value.sourceStartMs as number) ||
		!Number.isSafeInteger(value.sourceAudioStartTime) ||
		(value.sourceAudioStartTime as number) < 0 ||
		!Number.isSafeInteger(value.sourceAudioTrimStart) ||
		(value.sourceAudioTrimStart as number) < 0 ||
		!Number.isSafeInteger(value.sourceAudioDuration) ||
		(value.sourceAudioDuration as number) <= 0
	) {
		return null;
	}
	return {
		version: MANAGED_SUBTITLE_VERSION,
		cueSetId: value.cueSetId,
		dialogueLineId: value.dialogueLineId,
		storySceneId: value.storySceneId,
		storyShotId: value.storyShotId,
		speechAssetId: value.speechAssetId,
		sourceAudioElementId: value.sourceAudioElementId,
		sourceCueIndex: value.sourceCueIndex as number,
		sourceStartMs: value.sourceStartMs as number,
		sourceEndMs: value.sourceEndMs as number,
		sourceAudioStartTime: value.sourceAudioStartTime as number,
		sourceAudioTrimStart: value.sourceAudioTrimStart as number,
		sourceAudioDuration: value.sourceAudioDuration as number,
	};
}

function managedSubtitleDialogueLineId(
	element: EditorTimelineElement,
): string | null {
	if (element.type !== "text") {
		return null;
	}
	if (
		isRecord(element.manju) &&
		isRecord(element.manju.subtitleCue) &&
		isSafeIdentifier(element.manju.subtitleCue.dialogueLineId)
	) {
		return element.manju.subtitleCue.dialogueLineId;
	}
	if (
		element.params?.manjuRole === MANAGED_SUBTITLE_ROLE &&
		isSafeIdentifier(element.params.dialogueLineId)
	) {
		return element.params.dialogueLineId;
	}
	return null;
}

function subtitleCueSetProvenance(
	metadata: ManagedSubtitleCueProvenance,
): ManagedSubtitleCueSetProvenance {
	return {
		version: MANAGED_SUBTITLE_VERSION,
		cueSetId: metadata.cueSetId,
		dialogueLineId: metadata.dialogueLineId,
		storySceneId: metadata.storySceneId,
		storyShotId: metadata.storyShotId,
		speechAssetId: metadata.speechAssetId,
		sourceAudioElementId: metadata.sourceAudioElementId,
		sourceAudioStartTime: metadata.sourceAudioStartTime,
		sourceAudioTrimStart: metadata.sourceAudioTrimStart,
		sourceAudioDuration: metadata.sourceAudioDuration,
	};
}

function sameSubtitleCueSetProvenance(
	left: ManagedSubtitleCueSetProvenance,
	right: ManagedSubtitleCueSetProvenance,
): boolean {
	return (
		left.version === right.version &&
		left.cueSetId === right.cueSetId &&
		left.dialogueLineId === right.dialogueLineId &&
		left.storySceneId === right.storySceneId &&
		left.storyShotId === right.storyShotId &&
		left.speechAssetId === right.speechAssetId &&
		left.sourceAudioElementId === right.sourceAudioElementId &&
		left.sourceAudioStartTime === right.sourceAudioStartTime &&
		left.sourceAudioTrimStart === right.sourceAudioTrimStart &&
		left.sourceAudioDuration === right.sourceAudioDuration
	);
}

function flatSubtitleCueParamsMatch(
	element: EditorTimelineElement,
	metadata: ManagedSubtitleCueProvenance,
): boolean {
	const params = element.params;
	return (
		params !== undefined &&
		typeof params.content === "string" &&
		params.content.length > 0 &&
		element.name === params.content &&
		params.text === params.content &&
		params.manjuRole === MANAGED_SUBTITLE_ROLE &&
		params.dialogueLineId === metadata.dialogueLineId &&
		params.storySceneId === metadata.storySceneId &&
		params.storyShotId === metadata.storyShotId &&
		params.speechAssetId === metadata.speechAssetId &&
		params.sourceAudioElementId === metadata.sourceAudioElementId &&
		params.subtitleCueSetId === metadata.cueSetId &&
		params.sourceCueIndex === metadata.sourceCueIndex
	);
}

function allTimelineElements(
	tracks: EditorSceneTracks,
): Array<{
	trackId: string;
	trackType: "overlay" | "main" | "audio";
	element: EditorTimelineElement;
}> {
	return [
		...tracks.overlay.flatMap((track) =>
			track.elements.map((element) => ({
				trackId: track.id,
				trackType: "overlay" as const,
				element,
			})),
		),
		...tracks.main.elements.map((element) => ({
			trackId: tracks.main.id,
			trackType: "main" as const,
			element,
		})),
		...tracks.audio.flatMap((track) =>
			track.elements.map((element) => ({
				trackId: track.id,
				trackType: "audio" as const,
				element,
			})),
		),
	];
}

function sourceAudioElement(
	tracks: EditorSceneTracks,
	sourceAudioElementId: string,
): EditorTimelineElement | null {
	const matches = allTimelineElements(tracks).filter(
		(item) => item.element.id === sourceAudioElementId,
	);
	if (
		matches.length !== 1 ||
		matches[0]?.trackType !== "audio" ||
		matches[0].element.type !== "audio"
	) {
		return null;
	}
	return matches[0].element;
}

function hasConflictingSourceBinding(
	element: EditorTimelineElement,
	provenance: ManagedSubtitleCueSetProvenance,
): boolean {
	const params = element.params;
	return (
		params?.dialogueLineId !== provenance.dialogueLineId ||
		params?.storySceneId !== provenance.storySceneId ||
		params?.storyShotId !== provenance.storyShotId
	);
}

function validateCurrentSourceAudio(
	tracks: EditorSceneTracks,
	input: ReplaceManagedSubtitleCueSetInput,
): void {
	const audio = sourceAudioElement(tracks, input.sourceAudioElementId);
	if (!audio) {
		throw new Error("source audio element is missing or not on an audio track");
	}
	if (audio.mediaId !== input.speechAssetId) {
		throw new Error("source audio asset does not match speechAssetId");
	}
	if (audio.startTime !== input.sourceAudioStartTime) {
		throw new Error("source audio start time changed");
	}
	if ((audio.trimStart ?? 0) !== input.sourceAudioTrimStart) {
		throw new Error("source audio trim start changed");
	}
	if (audio.duration !== input.sourceAudioDuration) {
		throw new Error("source audio duration changed");
	}
	const provenance: ManagedSubtitleCueSetProvenance = {
		version: MANAGED_SUBTITLE_VERSION,
		cueSetId: input.cueSetId,
		dialogueLineId: input.dialogueLineId,
		storySceneId: input.storySceneId,
		storyShotId: input.storyShotId,
		speechAssetId: input.speechAssetId,
		sourceAudioElementId: input.sourceAudioElementId,
		sourceAudioStartTime: input.sourceAudioStartTime,
		sourceAudioTrimStart: input.sourceAudioTrimStart,
		sourceAudioDuration: input.sourceAudioDuration,
	};
	if (hasConflictingSourceBinding(audio, provenance)) {
		throw new Error("source audio story binding conflicts with the cue set");
	}
}

function toUpstreamElement(element: EditorTimelineElement): TimelineElement {
	return {
		...structuredClone(element),
		id: element.id,
		type: element.type,
		name: element.name ?? element.id,
		startTime: mediaTime({ ticks: element.startTime }),
		duration: mediaTime({ ticks: element.duration }),
		trimStart: mediaTime({ ticks: element.trimStart ?? 0 }),
		trimEnd: mediaTime({ ticks: element.trimEnd ?? 0 }),
		...(element.sourceDuration === undefined
			? {}
			: { sourceDuration: mediaTime({ ticks: element.sourceDuration }) }),
		params: { ...(element.params ?? {}) },
		...(element.animations === undefined
			? {}
			: { animations: element.animations as ElementAnimations }),
		...(element.retime === undefined ? {} : { retime: { ...element.retime } }),
	} as TimelineElement;
}

function toUpstreamCreateElement(
	element: EditorCreateTimelineElement,
): CreateTimelineElement {
	return {
		...structuredClone(element),
		type: element.type,
		name: element.name,
		startTime: mediaTime({ ticks: element.startTime }),
		duration: mediaTime({ ticks: element.duration }),
		trimStart: mediaTime({ ticks: element.trimStart }),
		trimEnd: mediaTime({ ticks: element.trimEnd }),
		...(element.sourceDuration === undefined
			? {}
			: { sourceDuration: mediaTime({ ticks: element.sourceDuration }) }),
		params: { ...element.params },
		...(element.animations === undefined
			? {}
			: { animations: element.animations as ElementAnimations }),
		...(element.retime === undefined ? {} : { retime: { ...element.retime } }),
	} as CreateTimelineElement;
}

function toUpstreamTracks(tracks: EditorSceneTracks): SceneTracks {
	return {
		overlay: tracks.overlay.map((track) => ({
			...structuredClone(track),
			id: track.id,
			type: track.type,
			elements: track.elements.map(toUpstreamElement),
		})),
		main: {
			...structuredClone(tracks.main),
			id: tracks.main.id,
			type: "video",
			elements: tracks.main.elements.map(toUpstreamElement),
		},
		audio: tracks.audio.map((track) => ({
			...structuredClone(track),
			id: track.id,
			type: "audio",
			elements: track.elements.map(toUpstreamElement),
		})),
	};
}

function toEditorElement(element: TimelineElement): EditorTimelineElement {
	return {
		...structuredClone(element),
		id: element.id,
		type: element.type,
		name: element.name,
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		...(element.sourceDuration === undefined
			? {}
			: { sourceDuration: element.sourceDuration }),
		params: { ...element.params },
		...(element.animations === undefined
			? {}
			: {
					animations: element.animations as unknown as Record<string, unknown>,
				}),
		...(element.retime === undefined ? {} : { retime: { ...element.retime } }),
	};
}

function toEditorTracks(tracks: SceneTracks): EditorSceneTracks {
	return {
		overlay: tracks.overlay.map((track) => ({
			...structuredClone(track),
			id: track.id,
			type: track.type,
			elements: track.elements.map(toEditorElement),
		})),
		main: {
			...structuredClone(tracks.main),
			id: tracks.main.id,
			type: "video",
			elements: tracks.main.elements.map(toEditorElement),
		},
		audio: tracks.audio.map((track) => ({
			...structuredClone(track),
			id: track.id,
			type: "audio",
			elements: track.elements.map(toEditorElement),
		})),
	};
}

function createManagedSubtitleElement(
	input: ReplaceManagedSubtitleCueSetInput,
	cue: ManagedSubtitleCueInput,
	sourceCueIndex: number,
	elementId: string,
): EditorTimelineElement {
	const subtitleCue: ManagedSubtitleCueProvenance = {
		version: MANAGED_SUBTITLE_VERSION,
		cueSetId: input.cueSetId,
		dialogueLineId: input.dialogueLineId,
		storySceneId: input.storySceneId,
		storyShotId: input.storyShotId,
		speechAssetId: input.speechAssetId,
		sourceAudioElementId: input.sourceAudioElementId,
		sourceCueIndex,
		sourceStartMs: cue.sourceStartMs,
		sourceEndMs: cue.sourceEndMs,
		sourceAudioStartTime: input.sourceAudioStartTime,
		sourceAudioTrimStart: input.sourceAudioTrimStart,
		sourceAudioDuration: input.sourceAudioDuration,
	};
	return {
		id: elementId,
		type: "text",
		name: cue.text,
		startTime: cue.startTime,
		duration: cue.duration,
		trimStart: 0,
		trimEnd: 0,
		params: {
			content: cue.text,
			text: cue.text,
			manjuRole: MANAGED_SUBTITLE_ROLE,
			dialogueLineId: input.dialogueLineId,
			storySceneId: input.storySceneId,
			storyShotId: input.storyShotId,
			speechAssetId: input.speechAssetId,
			sourceAudioElementId: input.sourceAudioElementId,
			subtitleCueSetId: input.cueSetId,
			sourceCueIndex,
		},
		manju: { subtitleCue },
	};
}

function generateUniqueSubtitleElementId(usedIds: Set<string>): string {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const candidate = `managed-subtitle-${generateUUID()}`;
		if (!usedIds.has(candidate)) {
			return candidate;
		}
	}
	throw new Error("unable to allocate a unique managed subtitle element id");
}

function buildManagedSubtitleAfterState(
	tracks: EditorSceneTracks,
	input: ReplaceManagedSubtitleCueSetInput,
): EditorSceneTracks {
	const after = structuredClone(tracks);
	const reservedOwners = [
		...after.overlay.map((track) => ({ kind: "overlay" as const, track })),
		{ kind: "main" as const, track: after.main },
		...after.audio.map((track) => ({ kind: "audio" as const, track })),
	].filter(({ track }) => track.id === MANAGED_SUBTITLE_TRACK_ID);
	if (
		reservedOwners.length > 1 ||
		(reservedOwners[0] !== undefined &&
			(reservedOwners[0].kind !== "overlay" ||
				reservedOwners[0].track.type !== "text"))
	) {
		throw new Error("managed subtitle track id is occupied by an invalid track");
	}

	const removed: EditorTimelineElement[] = [];
	const keepElement = (element: EditorTimelineElement): boolean => {
		if (managedSubtitleDialogueLineId(element) !== input.dialogueLineId) {
			return true;
		}
		removed.push(element);
		return false;
	};
	for (const track of after.overlay) {
		track.elements = track.elements.filter(keepElement);
	}
	after.main.elements = after.main.elements.filter(keepElement);
	for (const track of after.audio) {
		track.elements = track.elements.filter(keepElement);
	}

	let target = after.overlay.find(
		(track) => track.id === MANAGED_SUBTITLE_TRACK_ID,
	);
	if (!target) {
		target = {
			id: MANAGED_SUBTITLE_TRACK_ID,
			name: MANAGED_SUBTITLE_TRACK_NAME,
			type: "text",
			elements: [],
			hidden: false,
		};
		after.overlay.push(target);
	}
	for (const element of target.elements) {
		if (!parseSubtitleCueProvenance(element)) {
			throw new Error(
				"managed subtitle track contains a non-managed or malformed element",
			);
		}
	}

	const usedIds = new Set(
		allTimelineElements(after).map(({ element }) => element.id),
	);
	const reusableIds = new Map<number, string[]>();
	for (const element of removed) {
		const metadata = parseSubtitleCueProvenance(element);
		if (!metadata || metadata.cueSetId !== input.cueSetId) continue;
		reusableIds.set(metadata.sourceCueIndex, [
			...(reusableIds.get(metadata.sourceCueIndex) ?? []),
			element.id,
		]);
	}
	const takeReusableId = (sourceCueIndex: number): string | null => {
		const candidates = reusableIds.get(sourceCueIndex) ?? [];
		while (candidates.length > 0) {
			const candidate = candidates.shift();
			if (candidate && !usedIds.has(candidate)) return candidate;
		}
		return null;
	};
	const inserted = input.cues.map((cue, sourceCueIndex) => {
		const elementId =
			takeReusableId(sourceCueIndex) ??
			generateUniqueSubtitleElementId(usedIds);
		usedIds.add(elementId);
		return createManagedSubtitleElement(
			input,
			cue,
			sourceCueIndex,
			elementId,
		);
	});
	target.elements.push(...inserted);
	target.elements.sort(
		(left, right) =>
			left.startTime - right.startTime ||
			left.duration - right.duration ||
			left.id.localeCompare(right.id),
	);
	let previousEnd = 0;
	for (const [index, element] of target.elements.entries()) {
		if (
			!Number.isSafeInteger(element.startTime) ||
			!Number.isSafeInteger(element.duration) ||
			element.startTime < 0 ||
			element.duration <= 0 ||
			(index > 0 && element.startTime < previousEnd)
		) {
			throw new RangeError(
				"managed subtitle cues cannot overlap on the dedicated text track",
			);
		}
		previousEnd = element.startTime + element.duration;
	}
	return after;
}

interface ParsedSubtitleElement {
	trackId: string;
	element: EditorTimelineElement;
	metadata: ManagedSubtitleCueProvenance;
}

function readManagedSubtitleCueSetFromTracks(
	tracks: EditorSceneTracks,
	dialogueLineId: string,
	speechAssetId: string,
): ManagedSubtitleCueSetSnapshot | null {
	const looseMatches = allTimelineElements(tracks).filter(
		({ element }) =>
			managedSubtitleDialogueLineId(element) === dialogueLineId,
	);
	const parsedMatches = looseMatches.flatMap(
		({ trackId, element }): ParsedSubtitleElement[] => {
			const metadata = parseSubtitleCueProvenance(element);
			return metadata?.dialogueLineId === dialogueLineId
				? [{ trackId, element, metadata }]
				: [];
		},
	);
	if (parsedMatches.length === 0) {
		return null;
	}
	const first =
		parsedMatches.find(
			({ trackId }) => trackId === MANAGED_SUBTITLE_TRACK_ID,
		) ?? parsedMatches[0]!;
	const provenance = subtitleCueSetProvenance(first.metadata);
	const cueSetMatches = parsedMatches
		.filter(({ metadata }) => metadata.cueSetId === provenance.cueSetId)
		.sort(
			(left, right) =>
				left.metadata.sourceCueIndex - right.metadata.sourceCueIndex ||
				left.element.startTime - right.element.startTime ||
				left.element.id.localeCompare(right.element.id),
		);
	const reasons: ManagedSubtitleCueSetStaleReason[] = [];
	const addReason = (reason: ManagedSubtitleCueSetStaleReason): void => {
		if (!reasons.includes(reason)) reasons.push(reason);
	};
	if (
		looseMatches.length !== parsedMatches.length ||
		parsedMatches.length !== cueSetMatches.length ||
		first.trackId !== MANAGED_SUBTITLE_TRACK_ID ||
		cueSetMatches.some(
			({ trackId, metadata }) =>
				trackId !== first.trackId ||
				!sameSubtitleCueSetProvenance(
					subtitleCueSetProvenance(metadata),
					provenance,
				),
		)
	) {
		addReason("cue-set-inconsistent");
	}

	const cues = cueSetMatches.map(
		({ element, metadata }, index) => {
			if (
				metadata.sourceCueIndex !== index ||
				!flatSubtitleCueParamsMatch(element, metadata)
			) {
				addReason("cue-set-inconsistent");
			}
			const text =
				typeof element.params?.content === "string"
					? element.params.content
					: (element.name ?? "");
			return {
				elementId: element.id,
				sourceCueIndex: metadata.sourceCueIndex,
				text,
				startTime: element.startTime,
				duration: element.duration,
				sourceStartMs: metadata.sourceStartMs,
				sourceEndMs: metadata.sourceEndMs,
			};
		},
	);
	if (new Set(cues.map((cue) => cue.elementId)).size !== cues.length) {
		addReason("cue-set-inconsistent");
	}
	try {
		const validated = validateAndNormalizeSubtitleInput({
			cueSetId: provenance.cueSetId,
			dialogueLineId: provenance.dialogueLineId,
			storySceneId: provenance.storySceneId,
			storyShotId: provenance.storyShotId,
			speechAssetId: provenance.speechAssetId,
			sourceAudioElementId: provenance.sourceAudioElementId,
			sourceAudioStartTime: provenance.sourceAudioStartTime,
			sourceAudioTrimStart: provenance.sourceAudioTrimStart,
			sourceAudioDuration: provenance.sourceAudioDuration,
			cues: cues.map((cue) => ({
				text: cue.text,
				startTime: cue.startTime,
				duration: cue.duration,
				sourceStartMs: cue.sourceStartMs,
				sourceEndMs: cue.sourceEndMs,
			})),
		});
		if (validated.cues.some((cue, index) => cue.text !== cues[index]?.text)) {
			addReason("cue-set-inconsistent");
		}
	} catch {
		addReason("cue-set-inconsistent");
	}

	if (provenance.speechAssetId !== speechAssetId) {
		addReason("speech-asset-mismatch");
	}
	const audio = sourceAudioElement(tracks, provenance.sourceAudioElementId);
	if (!audio) {
		addReason("source-audio-missing");
	} else {
		if (audio.mediaId !== provenance.speechAssetId) {
			addReason("source-audio-asset-mismatch");
		}
		if (audio.startTime !== provenance.sourceAudioStartTime) {
			addReason("source-audio-start-mismatch");
		}
		if ((audio.trimStart ?? 0) !== provenance.sourceAudioTrimStart) {
			addReason("source-audio-trim-mismatch");
		}
		if (audio.duration !== provenance.sourceAudioDuration) {
			addReason("source-audio-duration-mismatch");
		}
		if (hasConflictingSourceBinding(audio, provenance)) {
			addReason("source-audio-binding-mismatch");
		}
	}
	return {
		trackId: first.trackId,
		provenance,
		cues,
		stale: reasons.length > 0,
		staleReasons: reasons,
	};
}

class ReplaceManagedSubtitleCueSetCommand extends Command {
	constructor(
		private readonly before: SceneTracks,
		private readonly after: SceneTracks,
	) {
		super();
	}

	private apply(tracks: SceneTracks): CommandResult {
		const editor = EditorCore.getInstance();
		const selection = editor.selection.getSnapshot();
		const elementIdsByTrack = new Map(
			[
				...tracks.overlay,
				tracks.main,
				...tracks.audio,
			].map((track) => [
				track.id,
				new Set(track.elements.map((element) => element.id)),
			]),
		);
		const survives = (ref: { trackId: string; elementId: string }): boolean =>
			elementIdsByTrack.get(ref.trackId)?.has(ref.elementId) === true;
		editor.timeline.updateTracks(structuredClone(tracks));
		return {
			selection: {
				selectedElements: selection.selectedElements
					.filter(survives)
					.map((ref) => ({ ...ref })),
				selectedKeyframes: selection.selectedKeyframes
					.filter(survives)
					.map((ref) => ({ ...ref })),
				keyframeSelectionAnchor:
					selection.keyframeSelectionAnchor &&
					survives(selection.keyframeSelectionAnchor)
						? { ...selection.keyframeSelectionAnchor }
						: null,
				selectedMaskPoints:
					selection.selectedMaskPoints &&
					survives(selection.selectedMaskPoints)
						? {
								...selection.selectedMaskPoints,
								pointIds: [...selection.selectedMaskPoints.pointIds],
							}
						: null,
			},
		};
	}

	execute(): CommandResult {
		return this.apply(this.after);
	}

	undo(): void {
		EditorCore.getInstance().timeline.updateTracks(structuredClone(this.before));
	}

	redo(): CommandResult {
		return this.apply(this.after);
	}
}

class OpenCutCommandEditorAdapter implements OpenCutCommandEditor {
	readonly provenance = {
		project: "OpenCut-Classic" as const,
		commit: OPEN_CUT_CLASSIC_COMMIT,
	};

	private readonly editor: EditorCore;
	private readonly commands: CommandManager;
	readonly playback: OpenCutPlaybackController;

	constructor(
		tracks: EditorSceneTracks,
		frameRate: { numerator: number; denominator: number },
	) {
		this.editor = new EditorCore(
			toUpstreamTracks(structuredClone(tracks)),
			frameRate,
		);
		this.commands = new CommandManager(this.editor);
		const snapshot = (): OpenCutPlaybackSnapshot => ({
			isPlaying: this.editor.playback.getIsPlaying(),
			currentTime: this.editor.playback.getCurrentTime(),
			duration: this.editor.timeline.getTotalDuration(),
			volume: this.editor.playback.getVolume(),
			muted: this.editor.playback.isMuted(),
			isScrubbing: this.editor.playback.getIsScrubbing(),
		});
		this.playback = {
			getSnapshot: snapshot,
			play: () => this.editor.playback.play(),
			pause: () => this.editor.playback.pause(),
			toggle: () => this.editor.playback.toggle(),
			seek: (time) => this.editor.playback.seek({ time: mediaTime({ ticks: time }) }),
			setVolume: (volume) => this.editor.playback.setVolume({ volume }),
			mute: () => this.editor.playback.mute(),
			unmute: () => this.editor.playback.unmute(),
			toggleMute: () => this.editor.playback.toggleMute(),
			setScrubbing: (isScrubbing) =>
				this.editor.playback.setScrubbing({ isScrubbing }),
			subscribe: (listener) => {
				const notify = () => listener(snapshot());
				const unsubscribe = this.editor.playback.subscribe(notify);
				notify();
				return unsubscribe;
			},
			onUpdate: (listener) => this.editor.playback.onUpdate(listener),
			onSeek: (listener) => this.editor.playback.onSeek(listener),
		};
	}

	private activate(): void {
		EditorCore.activate(this.editor);
	}

	getTracks(): EditorSceneTracks {
		this.activate();
		return structuredClone(
			toEditorTracks(this.editor.scenes.getActiveScene().tracks),
		);
	}

	getSelection(): OpenCutEditorSelectionSnapshot {
		this.activate();
		const selection = this.editor.selection.getSnapshot();
		return {
			selectedElements: selection.selectedElements.map((element) => ({
				...element,
			})),
			selectedKeyframes: selection.selectedKeyframes.map((keyframe) => ({
				...keyframe,
			})),
			keyframeSelectionAnchor: selection.keyframeSelectionAnchor
				? { ...selection.keyframeSelectionAnchor }
				: null,
			selectedMaskPoints: selection.selectedMaskPoints
				? {
						...selection.selectedMaskPoints,
						pointIds: [...selection.selectedMaskPoints.pointIds],
					}
				: null,
		};
	}

	setSelectedElements(
		elements: EditorElementRef[],
	): OpenCutEditorSelectionSnapshot {
		this.activate();
		this.editor.selection.applySelectionPatch({
			patch: {
				selectedElements: elements.map((element) => ({ ...element })),
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			},
		});
		return this.getSelection();
	}

	addElement(input: AddElementInput): AddElementDecision | null {
		this.activate();
		const command = new InsertElementCommand({
			element: toUpstreamCreateElement(input.element),
			placement: { ...input.placement },
		});
		this.commands.execute({ command });
		const trackId = command.getTrackId();
		return trackId
			? { trackId, elementId: command.getElementId() }
			: null;
	}

	addTrack(input: AddTrackInput): AddTrackDecision {
		this.activate();
		const command = new AddTrackCommand({ ...input });
		this.commands.execute({ command });
		return { trackId: command.getTrackId() };
	}

	deleteElements(input: DeleteElementsInput): void {
		this.activate();
		this.commands.execute({
			command: new DeleteElementsCommand({
				elements: input.elements.map((element) => ({ ...element })),
			}),
		});
	}

	commitElementMoves(input: CommitElementMovesInput): void {
		this.activate();
		this.commands.execute({
			command: new MoveElementCommand({
				moves: input.moves.map((move) => ({
					...move,
					newStartTime: mediaTime({ ticks: move.newStartTime }),
				})),
				createTracks: input.createTracks.map((track) => ({ ...track })),
			}),
		});
	}

	commitElementUpdates(input: CommitElementUpdatesInput): void {
		this.activate();
		this.commands.execute({
			command: new UpdateElementsCommand({
				updates: input.updates.map((update) => ({
					trackId: update.trackId,
					elementId: update.elementId,
					patch: {
						trimStart: mediaTime({ ticks: update.patch.trimStart }),
						trimEnd: mediaTime({ ticks: update.patch.trimEnd }),
						startTime: mediaTime({ ticks: update.patch.startTime }),
						duration: mediaTime({ ticks: update.patch.duration }),
					},
				})),
			}),
		});
	}

	commitElementPropertyUpdates(input: CommitElementPropertyUpdatesInput): void {
		this.activate();
		this.commands.execute({
			command: new UpdateElementsCommand({
				updates: input.updates.map((update) => {
					const cloned = structuredClone(update.patch);
					const { animations, masks, ...propertyPatch } = cloned;
					return {
						trackId: update.trackId,
						elementId: update.elementId,
						patch: {
							...propertyPatch,
							...(animations === undefined
								? {}
								: { animations: animations as ElementAnimations }),
							...(masks === undefined ? {} : { masks }),
						} as Partial<TimelineElement>,
					};
				}),
			}),
		});
	}

	moveElements(input: MoveElementsInput): MoveElementsDecision | null {
		this.activate();
		const tracks = this.editor.scenes.getActiveScene().tracks;
		const group = buildMoveGroup({
			anchorRef: input.anchor,
			selectedElements: input.selectedElements ?? [input.anchor],
			tracks,
		});
		if (!group) {
			return null;
		}

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: mediaTime({ ticks: input.anchorStartTime }),
			target: {
				kind: "existingTrack",
				anchorTargetTrackId: input.targetTrackId,
			},
		});
		if (!result) {
			return null;
		}

		this.commands.execute({
			command: new MoveElementCommand({
				moves: result.moves,
				createTracks: result.createTracks,
			}),
		});
		return {
			moves: result.moves.map((move) => ({ ...move })),
		};
	}

	resizeElements(
		input: ResizeElementsInput,
	): ResizeElementsDecision | null {
		this.activate();
		const members = buildResizeMembers({
			tracks: this.editor.scenes.getActiveScene().tracks,
			selectedElements: input.elements,
		});
		if (members.length === 0) {
			return null;
		}

		const result = computeGroupResize({
			members,
			side: input.side,
			deltaTime: mediaTime({ ticks: input.deltaTime }),
			fps: input.fps,
		});
		const applied = hasResizeChanges({ members, result });
		if (applied) {
			this.commands.execute({
				command: new UpdateElementsCommand({
					updates: result.updates,
				}),
			});
		}

		return {
			applied,
			deltaTime: result.deltaTime,
			updates: result.updates.map((update) => ({
				trackId: update.trackId,
				elementId: update.elementId,
				patch: { ...update.patch },
			})),
		};
	}

	splitElements(input: SplitElementsInput): SplitElementsDecision {
		this.activate();
		const command = new SplitElementsCommand({
			elements: input.elements,
			splitTime: mediaTime({ ticks: input.splitTime }),
			retainSide: input.retainSide,
		});
		this.commands.execute({ command });
		return {
			rightSideElements: command
				.getRightSideElements()
				.map((element) => ({ ...element })),
		};
	}

	replaceManagedSubtitleCueSet(
		input: ReplaceManagedSubtitleCueSetInput,
	): ManagedSubtitleCueSetSnapshot {
		this.activate();
		const normalized = validateAndNormalizeSubtitleInput(input);
		const before = structuredClone(
			this.editor.scenes.getActiveScene().tracks,
		);
		const beforeDto = toEditorTracks(before);
		validateCurrentSourceAudio(beforeDto, normalized);
		const afterDto = buildManagedSubtitleAfterState(beforeDto, normalized);
		const expected = readManagedSubtitleCueSetFromTracks(
			afterDto,
			normalized.dialogueLineId,
			normalized.speechAssetId,
		);
		if (!expected || expected.stale) {
			throw new Error("managed subtitle after-state failed its integrity check");
		}
		this.commands.execute({
			command: new ReplaceManagedSubtitleCueSetCommand(
				before,
				toUpstreamTracks(afterDto),
			),
		});
		return structuredClone(expected);
	}

	readManagedSubtitleCueSet(
		dialogueLineId: string,
		speechAssetId: string,
	): ManagedSubtitleCueSetSnapshot | null {
		this.activate();
		assertIdentifier(dialogueLineId, "dialogueLineId");
		assertIdentifier(speechAssetId, "speechAssetId");
		return readManagedSubtitleCueSetFromTracks(
			toEditorTracks(this.editor.scenes.getActiveScene().tracks),
			dialogueLineId,
			speechAssetId,
		);
	}

	undo(): void {
		this.activate();
		this.commands.undo();
	}

	redo(): void {
		this.activate();
		this.commands.redo();
	}

	canUndo(): boolean {
		return this.commands.canUndo();
	}

	canRedo(): boolean {
		return this.commands.canRedo();
	}

	clearHistory(): void {
		this.commands.clear();
	}
}

/**
 * Creates the UI-neutral command host. The command classes, group move
 * resolver, resize math, split pipeline, and history manager are vendored
 * from the pinned OpenCut Classic commit; only DTO/runtime ports live here.
 */
export function createOpenCutCommandEditor({
	tracks,
	frameRate = { numerator: 24, denominator: 1 },
}: {
	tracks: EditorSceneTracks;
	frameRate?: { numerator: number; denominator: number };
}): OpenCutCommandEditor {
	if (
		!Number.isSafeInteger(frameRate.numerator) ||
		!Number.isSafeInteger(frameRate.denominator) ||
		frameRate.numerator <= 0 ||
		frameRate.denominator <= 0
	) {
		throw new TypeError("frameRate must contain positive safe integers");
	}
	return new OpenCutCommandEditorAdapter(tracks, frameRate);
}
