/**
 * UI-neutral editor contract. Manju React components depend on these DTOs,
 * never on OpenCut component or store types.
 */
export type TimelineTicks = number;

export type EditorElementType =
	| "audio"
	| "text"
	| "sticker"
	| "graphic"
	| "effect"
	| "video"
	| "image";

export type EditorTrackType =
	| "video"
	| "text"
	| "audio"
	| "graphic"
	| "effect";

export interface EditorTimelineElement {
	id: string;
	type: EditorElementType;
	startTime: TimelineTicks;
	duration: TimelineTicks;
	name?: string;
	trimStart?: TimelineTicks;
	trimEnd?: TimelineTicks;
	sourceDuration?: TimelineTicks;
	params?: Record<string, number | string | boolean>;
	animations?: Record<string, unknown>;
	retime?: {
		rate: number;
		maintainPitch?: boolean;
	};
	/** Pinned OpenCut image/video and uploaded-audio source identity. */
	mediaId?: string;
	/** Pinned OpenCut audio discriminant; required by the canonical wire codec. */
	sourceType?: "upload" | "library";
	sourceUrl?: string;
	isSourceAudioEnabled?: boolean;
	hidden?: boolean;
	effects?: Record<string, unknown>[];
	masks?: Record<string, unknown>[];
	stickerId?: string;
	intrinsicWidth?: number;
	intrinsicHeight?: number;
	definitionId?: string;
	effectType?: string;
	/** Manju-owned metadata; never substitutes for OpenCut union fields. */
	manju?: Record<string, unknown>;
}

/**
 * Canonical element creation surface used by the command boundary. Unlike the
 * permissive read DTO above, this is a discriminated union: OpenCut-required
 * source identity and subtype fields cannot be omitted by typed callers.
 */
export interface EditorCreateBaseTimelineElement {
	name: string;
	startTime: TimelineTicks;
	duration: TimelineTicks;
	trimStart: TimelineTicks;
	trimEnd: TimelineTicks;
	sourceDuration?: TimelineTicks;
	params: Record<string, number | string | boolean>;
	animations?: Record<string, unknown>;
	retime?: {
		rate: number;
		maintainPitch?: boolean;
	};
	hidden?: boolean;
	effects?: Record<string, unknown>[];
	manju?: Record<string, unknown>;
}

export interface EditorCreateVideoElement
	extends EditorCreateBaseTimelineElement {
	type: "video";
	mediaId: string;
	isSourceAudioEnabled?: boolean;
	masks?: Record<string, unknown>[];
}

export interface EditorCreateImageElement
	extends EditorCreateBaseTimelineElement {
	type: "image";
	mediaId: string;
	masks?: Record<string, unknown>[];
}

export interface EditorCreateUploadAudioElement
	extends EditorCreateBaseTimelineElement {
	type: "audio";
	sourceType: "upload";
	mediaId: string;
}

export interface EditorCreateLibraryAudioElement
	extends EditorCreateBaseTimelineElement {
	type: "audio";
	sourceType: "library";
	sourceUrl: string;
}

export interface EditorCreateTextElement
	extends EditorCreateBaseTimelineElement {
	type: "text";
	params: Record<string, number | string | boolean> & { content: string };
}

export interface EditorCreateStickerElement
	extends EditorCreateBaseTimelineElement {
	type: "sticker";
	stickerId: string;
	intrinsicWidth?: number;
	intrinsicHeight?: number;
}

export interface EditorCreateGraphicElement
	extends EditorCreateBaseTimelineElement {
	type: "graphic";
	definitionId: string;
	masks?: Record<string, unknown>[];
}

export interface EditorCreateEffectElement
	extends EditorCreateBaseTimelineElement {
	type: "effect";
	effectType: string;
}

export type EditorCreateTimelineElement =
	| EditorCreateUploadAudioElement
	| EditorCreateLibraryAudioElement
	| EditorCreateVideoElement
	| EditorCreateImageElement
	| EditorCreateTextElement
	| EditorCreateStickerElement
	| EditorCreateGraphicElement
	| EditorCreateEffectElement;

export interface EditorOverlayTrack {
	id: string;
	name?: string;
	type: Exclude<EditorTrackType, "audio">;
	elements: EditorTimelineElement[];
	hidden?: boolean;
	muted?: boolean;
}

export interface EditorVideoTrack {
	id: string;
	name?: string;
	type: "video";
	elements: EditorTimelineElement[];
	hidden?: boolean;
	muted?: boolean;
}

export interface EditorAudioTrack {
	id: string;
	name?: string;
	type: "audio";
	elements: EditorTimelineElement[];
	muted?: boolean;
}

export interface EditorSceneTracks {
	overlay: EditorOverlayTrack[];
	main: EditorVideoTrack;
	audio: EditorAudioTrack[];
}

export interface PlacementTimeSpan {
	startTime: TimelineTicks;
	duration: TimelineTicks;
	excludeElementId?: string;
}

export type PlacementStrategy =
	| { type: "explicit"; trackId: string }
	| { type: "firstAvailable" }
	| {
			type: "preferIndex";
			trackIndex: number;
			hoverDirection: "above" | "below";
			verticalDragDirection?: "up" | "down" | null;
			createNewTrackOnly?: boolean;
	  }
	| { type: "aboveSource"; sourceTrackIndex: number }
	| { type: "alwaysNew"; position: "highest" | "default" };

type PlacementSubject =
	| { elementType: EditorElementType; trackType?: never }
	| { trackType: EditorTrackType; elementType?: never };

export type ResolvePlacementInput = PlacementSubject & {
	tracks: EditorSceneTracks;
	timeSpans: PlacementTimeSpan[];
	strategy: PlacementStrategy;
};

export type PlacementDecision =
	| {
			kind: "existingTrack";
			trackId: string;
			trackIndex: number;
			trackType: EditorTrackType;
			adjustedStartTime?: TimelineTicks;
	  }
	| {
			kind: "newTrack";
			insertIndex: number;
			insertPosition: "above" | "below" | null;
			trackType: EditorTrackType;
	  };

export type TimelineSnapPointType =
	| "element-start"
	| "element-end"
	| "playhead"
	| "bookmark"
	| "keyframe";

export interface TimelineSnapPoint {
	time: TimelineTicks;
	type: TimelineSnapPointType;
	elementId?: string;
	trackId?: string;
}

/** One source normally represents clip edges, playhead, bookmarks, or keyframes. */
export interface TimelineSnapSource {
	getSnapPoints(): Iterable<TimelineSnapPoint>;
}

export interface ResolveSnapInput {
	targetTime: TimelineTicks;
	sources: TimelineSnapSource[];
	zoomLevel: number;
	snapThresholdPx?: number;
}

export interface SnapDecision {
	snappedTime: TimelineTicks;
	snapPoint: TimelineSnapPoint | null;
	/** Null means that no point was inside the OpenCut threshold. */
	snapDistance: number | null;
}

export interface CanPlaceInput {
	track: { elements: EditorTimelineElement[] };
	timeSpans: PlacementTimeSpan[];
}

export interface OpenCutTimelineEngine {
	readonly provenance: {
		project: "OpenCut-Classic";
		commit: string;
	};
	resolvePlacement(input: ResolvePlacementInput): PlacementDecision | null;
	resolveSnap(input: ResolveSnapInput): SnapDecision;
	canPlace(input: CanPlaceInput): boolean;
	getTrackTypeForElement(elementType: EditorElementType): EditorTrackType;
	isElementTrackCompatible(
		elementType: EditorElementType,
		trackType: EditorTrackType,
	): boolean;
}

export interface EditorElementRef {
	trackId: string;
	elementId: string;
}

export interface EditorSelectedKeyframeRef extends EditorElementRef {
	propertyPath: string;
	keyframeId: string;
}

export interface EditorSelectedMaskPoints extends EditorElementRef {
	maskId: string;
	pointIds: string[];
}

/** Exact UI-neutral projection of OpenCut's editor-owned selection state. */
export interface OpenCutEditorSelectionSnapshot {
	selectedElements: EditorElementRef[];
	selectedKeyframes: EditorSelectedKeyframeRef[];
	keyframeSelectionAnchor: EditorSelectedKeyframeRef | null;
	selectedMaskPoints: EditorSelectedMaskPoints | null;
}

export type AddElementPlacement =
	| { mode: "explicit"; trackId: string }
	| {
			mode: "auto";
			trackType?: EditorTrackType;
			/** Ordered OpenCut track index; forwarded only when a track is created. */
			insertIndex?: number;
	  };

export interface AddElementInput {
	element: EditorCreateTimelineElement;
	placement: AddElementPlacement;
}

export interface AddElementDecision {
	trackId: string;
	elementId: string;
}

export interface AddTrackInput {
	type: EditorTrackType;
	/** Ordered OpenCut track index. Omit for the pinned default insertion rule. */
	index?: number;
}

export interface AddTrackDecision {
	trackId: string;
}

export interface DeleteElementsInput {
	elements: EditorElementRef[];
}

export interface EditorFrameRate {
	numerator: number;
	denominator: number;
}

export interface MoveElementsInput {
	anchor: EditorElementRef;
	selectedElements?: EditorElementRef[];
	anchorStartTime: TimelineTicks;
	targetTrackId: string;
}

export interface MoveElementsDecision {
	moves: Array<{
		sourceTrackId: string;
		targetTrackId: string;
		elementId: string;
		newStartTime: TimelineTicks;
	}>;
}

/** Exact resolved move plan emitted by OpenCut's interaction controller. */
export interface CommitElementMovesInput {
	moves: Array<{
		sourceTrackId: string;
		targetTrackId: string;
		elementId: string;
		newStartTime: TimelineTicks;
	}>;
	createTracks: Array<{
		id: string;
		type: EditorTrackType;
		index: number;
	}>;
}

export interface ElementUpdateEntry {
	trackId: string;
	elementId: string;
	patch: {
		trimStart: TimelineTicks;
		trimEnd: TimelineTicks;
		startTime: TimelineTicks;
		duration: TimelineTicks;
	};
}

/** Exact resolved update plan emitted by OpenCut's resize controller. */
export interface CommitElementUpdatesInput {
	updates: ElementUpdateEntry[];
}

export interface ElementPropertyUpdateEntry {
	trackId: string;
	elementId: string;
	patch: {
		name?: string;
		hidden?: boolean;
		isSourceAudioEnabled?: boolean;
		params?: Record<string, number | string | boolean>;
		/** Audited animation channels still execute via OpenCut UpdateElementsCommand. */
		animations?: Record<string, unknown>;
		/** Audited OpenCut masks still execute via the same atomic command. */
		masks?: Record<string, unknown>[];
	};
}

/** Property edits still flow through pinned OpenCut UpdateElementsCommand. */
export interface CommitElementPropertyUpdatesInput {
	updates: ElementPropertyUpdateEntry[];
}

export interface ResizeElementsInput {
	elements: EditorElementRef[];
	side: "left" | "right";
	deltaTime: TimelineTicks;
	fps: EditorFrameRate;
}

export interface ResizeElementsDecision {
	applied: boolean;
	deltaTime: TimelineTicks;
	updates: Array<{
		trackId: string;
		elementId: string;
		patch: {
			trimStart: TimelineTicks;
			trimEnd: TimelineTicks;
			startTime: TimelineTicks;
			duration: TimelineTicks;
		};
	}>;
}

export interface SplitElementsInput {
	elements: EditorElementRef[];
	splitTime: TimelineTicks;
	retainSide?: "both" | "left" | "right";
}

export interface SplitElementsDecision {
	rightSideElements: EditorElementRef[];
}

/** A single, already projected 24fps subtitle cue. */
export interface ManagedSubtitleCueInput {
	text: string;
	startTime: TimelineTicks;
	duration: TimelineTicks;
	sourceStartMs: number;
	sourceEndMs: number;
}

/**
 * Immutable source snapshot shared by every cue in a managed subtitle set.
 * The snapshot lets readers fail closed when the source audio is moved,
 * trimmed, replaced, or resized after the subtitle set was materialized.
 */
export interface ManagedSubtitleCueSetProvenance {
	version: 1;
	cueSetId: string;
	dialogueLineId: string;
	storySceneId: string;
	storyShotId: string;
	speechAssetId: string;
	sourceAudioElementId: string;
	sourceAudioStartTime: TimelineTicks;
	sourceAudioTrimStart: TimelineTicks;
	sourceAudioDuration: TimelineTicks;
}

/** Exact `manju.subtitleCue` wire shape stored on each text element. */
export interface ManagedSubtitleCueProvenance
	extends ManagedSubtitleCueSetProvenance {
	sourceCueIndex: number;
	sourceStartMs: number;
	sourceEndMs: number;
}

export interface ReplaceManagedSubtitleCueSetInput
	extends Omit<ManagedSubtitleCueSetProvenance, "version"> {
	cues: ManagedSubtitleCueInput[];
}

export interface ManagedSubtitleCueSnapshot extends ManagedSubtitleCueInput {
	elementId: string;
	sourceCueIndex: number;
}

export type ManagedSubtitleCueSetStaleReason =
	| "speech-asset-mismatch"
	| "source-audio-missing"
	| "source-audio-asset-mismatch"
	| "source-audio-start-mismatch"
	| "source-audio-trim-mismatch"
	| "source-audio-duration-mismatch"
	| "source-audio-binding-mismatch"
	| "cue-set-inconsistent";

export interface ManagedSubtitleCueSetSnapshot {
	trackId: string;
	provenance: ManagedSubtitleCueSetProvenance;
	cues: ManagedSubtitleCueSnapshot[];
	stale: boolean;
	staleReasons: ManagedSubtitleCueSetStaleReason[];
}

export interface OpenCutCommandEditor {
	readonly provenance: {
		project: "OpenCut-Classic";
		commit: string;
	};
	readonly playback: OpenCutPlaybackController;
	getTracks(): EditorSceneTracks;
	getSelection(): OpenCutEditorSelectionSnapshot;
	setSelectedElements(elements: EditorElementRef[]): OpenCutEditorSelectionSnapshot;
	addElement(input: AddElementInput): AddElementDecision | null;
	addTrack(input: AddTrackInput): AddTrackDecision;
	deleteElements(input: DeleteElementsInput): void;
	commitElementMoves(input: CommitElementMovesInput): void;
	commitElementUpdates(input: CommitElementUpdatesInput): void;
	commitElementPropertyUpdates(input: CommitElementPropertyUpdatesInput): void;
	moveElements(input: MoveElementsInput): MoveElementsDecision | null;
	resizeElements(input: ResizeElementsInput): ResizeElementsDecision | null;
	splitElements(input: SplitElementsInput): SplitElementsDecision;
	replaceManagedSubtitleCueSet(
		input: ReplaceManagedSubtitleCueSetInput,
	): ManagedSubtitleCueSetSnapshot;
	readManagedSubtitleCueSet(
		dialogueLineId: string,
		speechAssetId: string,
	): ManagedSubtitleCueSetSnapshot | null;
	undo(): void;
	redo(): void;
	canUndo(): boolean;
	canRedo(): boolean;
	clearHistory(): void;
}

export interface OpenCutPlaybackSnapshot {
	isPlaying: boolean;
	currentTime: TimelineTicks;
	duration: TimelineTicks;
	volume: number;
	muted: boolean;
	isScrubbing: boolean;
}

/**
 * UI-neutral facade over OpenCut Classic's PlaybackManager. The upstream
 * manager remains the clock authority; Manju only supplies media elements.
 */
export interface OpenCutPlaybackController {
	getSnapshot(): OpenCutPlaybackSnapshot;
	play(): void;
	pause(): void;
	toggle(): void;
	seek(time: TimelineTicks): void;
	setVolume(volume: number): void;
	mute(): void;
	unmute(): void;
	toggleMute(): void;
	setScrubbing(isScrubbing: boolean): void;
	subscribe(listener: (snapshot: OpenCutPlaybackSnapshot) => void): () => void;
	onUpdate(listener: (time: TimelineTicks) => void): () => void;
	onSeek(listener: (time: TimelineTicks) => void): () => void;
}

/**
 * The exact subset of a React/native mouse event consumed by OpenCut's
 * SeekController. React MouseEvent values are structurally compatible.
 */
export interface OpenCutTimelineMouseEvent {
	button: number;
	clientX: number;
	clientY: number;
	timeStamp: number;
	target: EventTarget;
}

/** The exact WheelEvent fields consumed by OpenCut's ZoomController. */
export interface OpenCutTimelineWheelEvent {
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	deltaX: number;
	deltaY: number;
	deltaMode: number;
}

export interface OpenCutTimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: TimelineTicks;
}

/**
 * Dynamic, UI-neutral host ports for the pinned seek and zoom controllers.
 * `getConfig()` is read for every gesture so React may close over current
 * state without allowing OpenCut styling or state stores across the boundary.
 */
export interface OpenCutTimelineInteractionConfig {
	minZoom: number;
	duration: TimelineTicks;
	isSelecting: boolean;
	getContainerEl(): HTMLDivElement | null;
	getPlayheadEl(): HTMLDivElement | null;
	getTrackLabelsEl(): HTMLDivElement | null;
	getRulerScrollEl(): HTMLDivElement | null;
	getTracksScrollEl(): HTMLDivElement | null;
	getActiveProjectFps(): EditorFrameRate | null;
	getCurrentPlayheadTime(): TimelineTicks;
	clearSelectedElements(): void;
	seek(time: TimelineTicks): void;
	setTimelineViewState(viewState: OpenCutTimelineViewState): void;
}

export type OpenCutZoomUpdater = number | ((previousZoom: number) => number);

export interface OpenCutTimelineInteractions {
	readonly provenance: {
		project: "OpenCut-Classic";
		commit: string;
	};
	readonly zoomLevel: number;
	subscribeZoom(listener: () => void): () => void;
	setZoomLevel(zoomLevelOrUpdater: OpenCutZoomUpdater): void;
	reconcileInitialAndMinZoom(input: {
		minZoom: number;
		initialZoom?: number;
	}): void;
	applyZoomLayout(): void;
	saveScrollPosition(): void;
	restoreInitialScrollIfNeeded(
		initialScrollLeft?: number,
	): (() => void) | undefined;
	restoreInitialPlayheadIfNeeded(initialPlayheadTime?: TimelineTicks): void;
	bindPreventBrowserZoom(): () => void;
	onTracksMouseDown(event: OpenCutTimelineMouseEvent): void;
	onTracksClick(event: OpenCutTimelineMouseEvent): void;
	onRulerMouseDown(event: OpenCutTimelineMouseEvent): void;
	onRulerClick(event: OpenCutTimelineMouseEvent): void;
	onWheel(event: OpenCutTimelineWheelEvent): void;
	destroy(): void;
}

export interface CreateOpenCutTimelineInteractionsInput {
	getConfig(): OpenCutTimelineInteractionConfig;
	initialZoom?: number;
}
