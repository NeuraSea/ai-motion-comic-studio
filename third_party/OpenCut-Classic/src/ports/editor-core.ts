import type {
	EditorSelectionPatch,
	EditorSelectionSnapshot,
} from "./selection";
import { PlaybackManager } from "../core/managers/playback-manager";
import {
	addMediaTime,
	type FrameRate,
	type MediaTime,
	ZERO_MEDIA_TIME,
} from "./media-time";
import type { SceneTracks } from "./timeline";

function cloneSelection(
	snapshot: EditorSelectionSnapshot,
): EditorSelectionSnapshot {
	return {
		selectedElements: snapshot.selectedElements.map((ref) => ({ ...ref })),
		selectedKeyframes: snapshot.selectedKeyframes.map((ref) => ({ ...ref })),
		keyframeSelectionAnchor: snapshot.keyframeSelectionAnchor
			? { ...snapshot.keyframeSelectionAnchor }
			: null,
		selectedMaskPoints: snapshot.selectedMaskPoints
			? {
					...snapshot.selectedMaskPoints,
					pointIds: [...snapshot.selectedMaskPoints.pointIds],
				}
			: null,
	};
}

/**
 * Narrow host for the upstream command classes. It preserves the singleton
 * access pattern used by OpenCut commands without importing its React/Zustand
 * application core.
 */
export class EditorCore {
	private static instance: EditorCore | null = null;
	private tracks: SceneTracks;
	private readonly frameRate: FrameRate;
	private readonly timelineListeners = new Set<() => void>();
	private readonly sceneListeners = new Set<() => void>();
	private selectionSnapshot: EditorSelectionSnapshot = {
		selectedElements: [],
		selectedKeyframes: [],
		keyframeSelectionAnchor: null,
		selectedMaskPoints: null,
	};

	readonly playback: PlaybackManager;

	constructor(
		tracks: SceneTracks,
		frameRate: FrameRate = { numerator: 24, denominator: 1 },
	) {
		this.tracks = tracks;
		this.frameRate = { ...frameRate };
		this.playback = new PlaybackManager(this);
		this.playback.bindTimelineScope();
	}

	static activate(editor: EditorCore): void {
		EditorCore.instance = editor;
	}

	static getInstance(): EditorCore {
		if (!EditorCore.instance) {
			throw new Error("OpenCut command editor is not active");
		}
		return EditorCore.instance;
	}

	readonly scenes = {
		getActiveScene: (): { tracks: SceneTracks } => ({ tracks: this.tracks }),
		getActiveSceneOrNull: (): { tracks: SceneTracks } | null => ({
			tracks: this.tracks,
		}),
		subscribe: (listener: () => void): (() => void) => {
			this.sceneListeners.add(listener);
			return () => this.sceneListeners.delete(listener);
		},
	};

	readonly timeline = {
		updateTracks: (tracks: SceneTracks): void => {
			this.tracks = tracks;
			this.timelineListeners.forEach((listener) => listener());
		},
		getTotalDuration: (): MediaTime => {
			let maximum = ZERO_MEDIA_TIME;
			for (const track of [
				...this.tracks.overlay,
				this.tracks.main,
				...this.tracks.audio,
			]) {
				for (const element of track.elements) {
					const end = addMediaTime({
						a: element.startTime,
						b: element.duration,
					});
					if (end > maximum) maximum = end;
				}
			}
			return maximum;
		},
		subscribe: (listener: () => void): (() => void) => {
			this.timelineListeners.add(listener);
			return () => this.timelineListeners.delete(listener);
		},
	};

	readonly project = {
		getActive: (): { settings: { fps: FrameRate } } => ({
			settings: { fps: { ...this.frameRate } },
		}),
	};

	readonly selection = {
		getSnapshot: (): EditorSelectionSnapshot =>
			cloneSelection(this.selectionSnapshot),
		restoreSnapshot: ({ snapshot }: { snapshot: EditorSelectionSnapshot }): void => {
			this.selectionSnapshot = cloneSelection(snapshot);
		},
		applySelectionPatch: ({
			patch,
		}: {
			patch: EditorSelectionPatch;
		}): EditorSelectionSnapshot => {
			this.selectionSnapshot = cloneSelection({
				...this.selectionSnapshot,
				...patch,
			});
			return cloneSelection(this.selectionSnapshot);
		},
	};
}
