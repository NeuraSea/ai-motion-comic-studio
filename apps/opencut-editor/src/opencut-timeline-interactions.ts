import {
	SeekController,
	type SeekConfig,
	type SeekConfigRef,
} from "../../../third_party/OpenCut-Classic/src/timeline/controllers/seek-controller.js";
import {
	ZoomController,
	type ZoomConfig,
	type ZoomConfigRef,
} from "../../../third_party/OpenCut-Classic/src/timeline/controllers/zoom-controller.js";
import { mediaTime } from "../../../third_party/OpenCut-Classic/src/ports/media-time.js";
import type {
	CreateOpenCutTimelineInteractionsInput,
	OpenCutTimelineInteractions,
	OpenCutTimelineViewState,
} from "./contracts.js";
import { OPEN_CUT_CLASSIC_COMMIT } from "./opencut-timeline-engine.js";

function toHostViewState(viewState: {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: number;
}): OpenCutTimelineViewState {
	return {
		zoomLevel: viewState.zoomLevel,
		scrollLeft: viewState.scrollLeft,
		playheadTime: viewState.playheadTime,
	};
}

/**
 * UI-neutral facade over the exact pinned OpenCut SeekController and
 * ZoomController. Manju owns DOM creation and React lifecycle; OpenCut owns
 * click qualification, px-to-time conversion, frame snapping, wheel zoom,
 * playhead anchoring, and persisted view-state timing.
 */
export function createOpenCutTimelineInteractions(
	input: CreateOpenCutTimelineInteractionsInput,
): OpenCutTimelineInteractions {
	const zoomConfigRef: ZoomConfigRef = {
		get current(): ZoomConfig {
			const config = input.getConfig();
			return {
				minZoom: config.minZoom,
				getContainerEl: () => config.getContainerEl(),
				getTracksScrollEl: () => config.getTracksScrollEl(),
				getRulerScrollEl: () => config.getRulerScrollEl(),
				getCurrentPlayheadTime: () =>
					mediaTime({ ticks: config.getCurrentPlayheadTime() }),
				seek: (time) => config.seek(time),
				setTimelineViewState: (viewState) =>
					config.setTimelineViewState(toHostViewState(viewState)),
			};
		},
	};
	const zoom = new ZoomController({
		configRef: zoomConfigRef,
		initialZoom: input.initialZoom,
	});

	const seekConfigRef: SeekConfigRef = {
		get current(): SeekConfig {
			const config = input.getConfig();
			return {
				zoomLevel: zoom.zoomLevel,
				duration: mediaTime({ ticks: config.duration }),
				isSelecting: config.isSelecting,
				getPlayheadEl: () => config.getPlayheadEl(),
				getTrackLabelsEl: () => config.getTrackLabelsEl(),
				getRulerScrollEl: () => config.getRulerScrollEl(),
				getTracksScrollEl: () => config.getTracksScrollEl(),
				getActiveProjectFps: () => config.getActiveProjectFps(),
				clearSelectedElements: () => config.clearSelectedElements(),
				seek: (time) => config.seek(time),
				setTimelineViewState: (viewState) =>
					config.setTimelineViewState(toHostViewState(viewState)),
			};
		},
	};
	const seek = new SeekController({ configRef: seekConfigRef });

	return {
		provenance: {
			project: "OpenCut-Classic",
			commit: OPEN_CUT_CLASSIC_COMMIT,
		},
		get zoomLevel() {
			return zoom.zoomLevel;
		},
		subscribeZoom: (listener) => zoom.subscribe(listener),
		setZoomLevel: zoom.setZoomLevel,
		reconcileInitialAndMinZoom: (params) =>
			zoom.reconcileInitialAndMinZoom(params),
		applyZoomLayout: () => zoom.applyZoomLayout(zoom.zoomLevel),
		saveScrollPosition: zoom.saveScrollPosition,
		restoreInitialScrollIfNeeded: (initialScrollLeft) =>
			zoom.restoreInitialScrollIfNeeded(initialScrollLeft),
		restoreInitialPlayheadIfNeeded: (initialPlayheadTime) =>
			zoom.restoreInitialPlayheadIfNeeded(
				initialPlayheadTime === undefined
					? undefined
					: mediaTime({ ticks: initialPlayheadTime }),
			),
		bindPreventBrowserZoom: () => zoom.bindPreventBrowserZoom(),
		onTracksMouseDown: seek.onTracksMouseDown,
		onTracksClick: seek.onTracksClick,
		onRulerMouseDown: seek.onRulerMouseDown,
		onRulerClick: seek.onRulerClick,
		onWheel: zoom.handleWheel,
		destroy: () => {
			seek.destroy();
			zoom.destroy();
		},
	};
}
