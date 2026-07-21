import { timelineTimeToPixels } from "./pixel-utils";
import { getTimelinePaddingPx } from "./zoom-utils";

/**
 * Pure extraction of the pinned timeline component's content-width,
 * zoom-dependent padding, and minimum viewport width policy.
 */
export function getTimelineLayoutDimensions({
	duration,
	zoomLevel,
	containerWidth,
	minZoom,
}: {
	duration: number;
	zoomLevel: number;
	containerWidth: number;
	minZoom: number;
}): {
	contentWidth: number;
	paddingPx: number;
	dynamicTimelineWidth: number;
} {
	const contentWidth = timelineTimeToPixels({ time: duration, zoomLevel });
	const paddingPx = getTimelinePaddingPx({
		containerWidth,
		zoomLevel,
		minZoom,
	});
	const dynamicTimelineWidth = Math.max(
		contentWidth + paddingPx,
		containerWidth,
	);

	return { contentWidth, paddingPx, dynamicTimelineWidth };
}
