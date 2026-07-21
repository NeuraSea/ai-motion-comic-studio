import {
	canElementGoOnTrack,
	getTrackTypeForElementType,
} from "../../../third_party/OpenCut-Classic/src/timeline/placement/compatibility.js";
import { canPlaceTimeSpansOnTrack } from "../../../third_party/OpenCut-Classic/src/timeline/placement/overlap.js";
import { resolveTrackPlacement } from "../../../third_party/OpenCut-Classic/src/timeline/placement/resolve.js";
import { buildTimelineSnapPoints } from "../../../third_party/OpenCut-Classic/src/timeline/snapping/build.js";
import { resolveTimelineSnap } from "../../../third_party/OpenCut-Classic/src/timeline/snapping/resolve.js";
import { getTimelineSnapThresholdInTicks } from "../../../third_party/OpenCut-Classic/src/timeline/snapping/threshold.js";
import { mediaTime } from "../../../third_party/OpenCut-Classic/src/ports/media-time.js";
import type {
	SceneTracks,
	TimelineElement,
} from "../../../third_party/OpenCut-Classic/src/ports/timeline.js";
import type {
	CanPlaceInput,
	EditorSceneTracks,
	EditorTimelineElement,
	OpenCutTimelineEngine,
	PlacementDecision,
	ResolvePlacementInput,
	ResolveSnapInput,
	SnapDecision,
	TimelineSnapPoint,
} from "./contracts.js";

export const OPEN_CUT_CLASSIC_COMMIT =
	"cf5e79e919144200294fb9fed22a222592a0aeea";
export const OPEN_CUT_TICKS_PER_SECOND = 120_000;

function toUpstreamElement(element: EditorTimelineElement): TimelineElement {
	return {
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
		params: element.params ?? {},
		...(element.retime === undefined ? {} : { retime: { ...element.retime } }),
	};
}

function toUpstreamTracks(tracks: EditorSceneTracks): SceneTracks {
	return {
		overlay: tracks.overlay.map((track) => ({
			id: track.id,
			type: track.type,
			elements: track.elements.map(toUpstreamElement),
		})),
		main: {
			id: tracks.main.id,
			type: "video",
			elements: tracks.main.elements.map(toUpstreamElement),
		},
		audio: tracks.audio.map((track) => ({
			id: track.id,
			type: "audio",
			elements: track.elements.map(toUpstreamElement),
		})),
	};
}

function resolvePlacement(
	input: ResolvePlacementInput,
): PlacementDecision | null {
	const subject =
		input.elementType !== undefined
			? { elementType: input.elementType }
			: { trackType: input.trackType };
	const result = resolveTrackPlacement({
		...subject,
		tracks: toUpstreamTracks(input.tracks),
		timeSpans: input.timeSpans.map((span) => ({
			startTime: mediaTime({ ticks: span.startTime }),
			duration: mediaTime({ ticks: span.duration }),
			excludeElementId: span.excludeElementId,
		})),
		strategy: input.strategy,
	});

	return result ? { ...result } : null;
}

function toUpstreamSnapPoint(point: TimelineSnapPoint) {
	return {
		...point,
		time: mediaTime({ ticks: point.time }),
	};
}

function resolveSnap(input: ResolveSnapInput): SnapDecision {
	const sources = input.sources.map((source) => () => {
		return Array.from(source.getSnapPoints(), toUpstreamSnapPoint);
	});
	const snapPoints = buildTimelineSnapPoints({ sources });
	const result = resolveTimelineSnap({
		targetTime: mediaTime({ ticks: input.targetTime }),
		snapPoints,
		maxSnapDistance: getTimelineSnapThresholdInTicks({
			zoomLevel: input.zoomLevel,
			snapThresholdPx: input.snapThresholdPx,
		}),
	});

	return {
		snappedTime: result.snappedTime,
		snapPoint: result.snapPoint ? { ...result.snapPoint } : null,
		snapDistance: result.snapPoint ? result.snapDistance : null,
	};
}

function canPlace(input: CanPlaceInput): boolean {
	return canPlaceTimeSpansOnTrack({
		track: {
			elements: input.track.elements.map(toUpstreamElement),
		},
		timeSpans: input.timeSpans.map((span) => ({
			startTime: mediaTime({ ticks: span.startTime }),
			duration: mediaTime({ ticks: span.duration }),
			excludeElementId: span.excludeElementId,
		})),
	});
}

/**
 * Creates the engine used by Manju-owned timeline UI. No OpenCut React,
 * Zustand, storage, or visual theme crosses this boundary.
 */
export function createOpenCutTimelineEngine(): OpenCutTimelineEngine {
	return {
		provenance: {
			project: "OpenCut-Classic",
			commit: OPEN_CUT_CLASSIC_COMMIT,
		},
		resolvePlacement,
		resolveSnap,
		canPlace,
		getTrackTypeForElement: (elementType) =>
			getTrackTypeForElementType({ elementType }),
		isElementTrackCompatible: (elementType, trackType) =>
			canElementGoOnTrack({ elementType, trackType }),
	};
}
