import type { SnapPoint } from "./snapping/types";
import type { MediaTime } from "../ports/media-time";

export function getPlayheadSnapPoints({
	playheadTime,
}: {
	playheadTime: MediaTime;
}): SnapPoint[] {
	return [{ time: playheadTime, type: "playhead" }];
}
