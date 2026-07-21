import type {
	EditorFrameRate,
	EditorSceneTracks,
	EditorTimelineElement,
} from "./contracts.js";
import { createOpenCutCommandEditor } from "./opencut-command-editor.js";
import { OPEN_CUT_TICKS_PER_SECOND } from "./opencut-timeline-engine.js";

export interface OpenCutElementTimingSnapshot {
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
}

/**
 * A deliberately small automation surface. Agents may propose these values,
 * but they never receive a general-purpose timeline JSON write primitive.
 */
export interface OpenCutAtomicTimingOperation {
	kind: "update-element-timing";
	trackId: string;
	elementId: string;
	reason: string;
	before: OpenCutElementTimingSnapshot;
	after: OpenCutElementTimingSnapshot;
}

export interface ApplyOpenCutAtomicEditInput {
	tracks: EditorSceneTracks;
	operations: readonly OpenCutAtomicTimingOperation[];
	frameRate?: EditorFrameRate;
}

export interface OpenCutAtomicEditResult {
	tracks: EditorSceneTracks;
	changedElementIds: string[];
}

export type OpenCutAtomicEditErrorCode =
	| "DUPLICATE_OPERATION"
	| "ELEMENT_NOT_FOUND"
	| "INVALID_OPERATION"
	| "PRECONDITION_FAILED"
	| "POSTCONDITION_FAILED";

export class OpenCutAtomicEditError extends Error {
	constructor(
		readonly code: OpenCutAtomicEditErrorCode,
		message: string,
	) {
		super(message);
		this.name = "OpenCutAtomicEditError";
	}
}

function allTracks(tracks: EditorSceneTracks) {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

function timingOf(element: EditorTimelineElement): OpenCutElementTimingSnapshot {
	return {
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart ?? 0,
		trimEnd: element.trimEnd ?? 0,
	};
}

function sameTiming(
	left: OpenCutElementTimingSnapshot,
	right: OpenCutElementTimingSnapshot,
): boolean {
	return (
		left.startTime === right.startTime &&
		left.duration === right.duration &&
		left.trimStart === right.trimStart &&
		left.trimEnd === right.trimEnd
	);
}

function assertSafeId(value: string, label: string): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 200 ||
		value.trim() !== value ||
		/\p{Cc}/u.test(value)
	) {
		throw new OpenCutAtomicEditError(
			"INVALID_OPERATION",
			`${label} is invalid`,
		);
	}
}

function assertTiming(
	value: OpenCutElementTimingSnapshot,
	label: string,
	frameTicks: number,
): void {
	for (const [key, item] of Object.entries(value)) {
		if (!Number.isSafeInteger(item) || item < 0) {
			throw new OpenCutAtomicEditError(
				"INVALID_OPERATION",
				`${label}.${key} must be a non-negative safe integer`,
			);
		}
		if (item % frameTicks !== 0) {
			throw new OpenCutAtomicEditError(
				"INVALID_OPERATION",
				`${label}.${key} is not frame-aligned`,
			);
		}
	}
	if (value.duration === 0) {
		throw new OpenCutAtomicEditError(
			"INVALID_OPERATION",
			`${label}.duration must be positive`,
		);
	}
}

function locate(
	tracks: EditorSceneTracks,
	trackId: string,
	elementId: string,
): EditorTimelineElement | null {
	const track = allTracks(tracks).find((candidate) => candidate.id === trackId);
	return track?.elements.find((element) => element.id === elementId) ?? null;
}

/**
 * Execute a complete automation proposal through one pinned OpenCut
 * UpdateElementsCommand. The command editor owns an isolated clone, so a
 * failed pre/postcondition can never partially mutate the caller's document.
 */
export function applyOpenCutAtomicEdit(
	input: ApplyOpenCutAtomicEditInput,
): OpenCutAtomicEditResult {
	const frameRate = input.frameRate ?? { numerator: 24, denominator: 1 };
	if (
		!Number.isSafeInteger(frameRate.numerator) ||
		!Number.isSafeInteger(frameRate.denominator) ||
		frameRate.numerator <= 0 ||
		frameRate.denominator <= 0
	) {
		throw new OpenCutAtomicEditError(
			"INVALID_OPERATION",
			"frameRate is invalid",
		);
	}
	const tickNumerator = OPEN_CUT_TICKS_PER_SECOND * frameRate.denominator;
	if (tickNumerator % frameRate.numerator !== 0) {
		throw new OpenCutAtomicEditError(
			"INVALID_OPERATION",
			"frameRate cannot be represented by OpenCut ticks",
		);
	}
	const frameTicks = tickNumerator / frameRate.numerator;
	const original = structuredClone(input.tracks);
	const keys = new Set<string>();
	for (const [index, operation] of input.operations.entries()) {
		if (operation.kind !== "update-element-timing") {
			throw new OpenCutAtomicEditError(
				"INVALID_OPERATION",
				`operations[${index}].kind is unsupported`,
			);
		}
		assertSafeId(operation.trackId, `operations[${index}].trackId`);
		assertSafeId(operation.elementId, `operations[${index}].elementId`);
		if (
			typeof operation.reason !== "string" ||
			operation.reason.trim().length === 0 ||
			operation.reason.length > 200
		) {
			throw new OpenCutAtomicEditError(
				"INVALID_OPERATION",
				`operations[${index}].reason is invalid`,
			);
		}
		assertTiming(operation.before, `operations[${index}].before`, frameTicks);
		assertTiming(operation.after, `operations[${index}].after`, frameTicks);
		const key = JSON.stringify([operation.trackId, operation.elementId]);
		if (keys.has(key)) {
			throw new OpenCutAtomicEditError(
				"DUPLICATE_OPERATION",
				`element ${operation.elementId} is updated more than once`,
			);
		}
		keys.add(key);
		const element = locate(original, operation.trackId, operation.elementId);
		if (!element) {
			throw new OpenCutAtomicEditError(
				"ELEMENT_NOT_FOUND",
				`element ${operation.elementId} is not on track ${operation.trackId}`,
			);
		}
		if (!sameTiming(timingOf(element), operation.before)) {
			throw new OpenCutAtomicEditError(
				"PRECONDITION_FAILED",
				`element ${operation.elementId} changed after the automation plan was created`,
			);
		}
	}

	if (input.operations.length === 0) {
		return { tracks: original, changedElementIds: [] };
	}
	const editor = createOpenCutCommandEditor({ tracks: original, frameRate });
	editor.commitElementUpdates({
		updates: input.operations.map((operation) => ({
			trackId: operation.trackId,
			elementId: operation.elementId,
			patch: { ...operation.after },
		})),
	});
	const tracks = editor.getTracks();
	for (const operation of input.operations) {
		const element = locate(tracks, operation.trackId, operation.elementId);
		if (!element || !sameTiming(timingOf(element), operation.after)) {
			throw new OpenCutAtomicEditError(
				"POSTCONDITION_FAILED",
				`OpenCut did not apply the requested timing for ${operation.elementId}`,
			);
		}
	}
	return {
		tracks,
		changedElementIds: input.operations.map((operation) => operation.elementId),
	};
}
