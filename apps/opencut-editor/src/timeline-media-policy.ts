/**
 * UI/server-neutral projection of the pinned OpenCut visibility and audio
 * flags. Preview and export must call this instead of interpreting the flags
 * independently.
 */
export interface TimelineMediaPolicyTrack {
	type: string;
	hidden?: boolean;
	muted?: boolean;
}

export interface TimelineMediaPolicyElement {
	type: string;
	hidden?: boolean;
	isSourceAudioEnabled?: boolean;
}

export interface TimelineMediaParticipation {
	visual: boolean;
	timelineAudio: boolean;
	sourceAudio: boolean;
}

export function isTimelineTrackHidden(track: TimelineMediaPolicyTrack): boolean {
	return track.type !== "audio" && track.hidden === true;
}

export function isTimelineElementHidden(
	track: TimelineMediaPolicyTrack,
	element: TimelineMediaPolicyElement,
): boolean {
	return isTimelineTrackHidden(track) || element.hidden === true;
}

export function projectTimelineMediaParticipation(
	track: TimelineMediaPolicyTrack,
	element: TimelineMediaPolicyElement,
): TimelineMediaParticipation {
	if (isTimelineElementHidden(track, element)) {
		return { visual: false, timelineAudio: false, sourceAudio: false };
	}
	if (track.type === "audio") {
		return {
			visual: false,
			timelineAudio: element.type === "audio" && track.muted !== true,
			sourceAudio: false,
		};
	}
	const visual = track.type === "video"
		&& (element.type === "image" || element.type === "video");
	return {
		visual,
		timelineAudio: false,
		sourceAudio: visual
			&& element.type === "video"
			&& element.isSourceAudioEnabled === true
			&& track.muted !== true,
	};
}

export type TimelineAssetScopeResult =
	| "allowed"
	| "project-mismatch"
	| "episode-mismatch";

/**
 * Project-global media is safe only for a canonical top-level mediaId. A
 * legacy params.assetId fallback remains episode-local until it is saved
 * through the canonical codec.
 */
export function classifyTimelineAssetScope(
	asset: { projectId: string; episodeId: string | null },
	scope: { projectId: string; episodeId: string },
	canonicalMediaId = true,
): TimelineAssetScopeResult {
	if (asset.projectId !== scope.projectId) return "project-mismatch";
	if (asset.episodeId === scope.episodeId) return "allowed";
	if (asset.episodeId === null && canonicalMediaId) return "allowed";
	return "episode-mismatch";
}
