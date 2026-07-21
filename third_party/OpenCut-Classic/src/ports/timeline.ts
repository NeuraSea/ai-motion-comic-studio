import type { MediaTime } from "./media-time";
import type { ElementAnimations } from "../animation/types";
import type { ParamValues } from "./params";

/**
 * Structural subset of OpenCut's timeline domain required by placement.
 * The algorithms intentionally depend on this port rather than Manju UI types.
 */
export type ElementType =
	| "audio"
	| "text"
	| "sticker"
	| "graphic"
	| "effect"
	| "video"
	| "image";

export type TrackType = "video" | "text" | "audio" | "graphic" | "effect";

export interface TimelineElement {
	id: string;
	type: ElementType;
	name: string;
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration?: MediaTime;
	animations?: ElementAnimations;
	params: ParamValues;
	retime?: RetimeConfig;
}

/**
 * UI-neutral creation shape consumed by the extracted InsertElementCommand.
 * The public adapter supplies a stricter discriminated union and converts it
 * to this structural OpenCut compatibility port.
 */
export type CreateTimelineElement = Omit<TimelineElement, "id"> &
	Record<string, unknown>;

export interface ElementRef {
	trackId: string;
	elementId: string;
}

export interface RetimeConfig {
	rate: number;
	maintainPitch?: boolean;
}

export const RETIMABLE_ELEMENT_TYPES = ["video", "audio"] as const;

export interface BaseTrack {
	id: string;
	name?: string;
	type: TrackType;
	elements: TimelineElement[];
	hidden?: boolean;
	muted?: boolean;
}

export interface VideoTrack extends BaseTrack {
	type: "video";
}

export interface AudioTrack extends BaseTrack {
	type: "audio";
}

export interface TextTrack extends BaseTrack {
	type: "text";
}

export interface GraphicTrack extends BaseTrack {
	type: "graphic";
}

export interface EffectTrack extends BaseTrack {
	type: "effect";
}

export type OverlayTrack = BaseTrack & {
	type: Exclude<TrackType, "audio">;
};

export type TimelineTrack = VideoTrack | AudioTrack | OverlayTrack;

export interface SceneTracks {
	overlay: OverlayTrack[];
	main: VideoTrack;
	audio: AudioTrack[];
}

export type ElementDragView =
	| { readonly kind: "idle" }
	| {
			readonly kind: "dragging";
			readonly anchorElementId: string;
			readonly trackId: string;
			readonly memberTimeOffsets: ReadonlyMap<string, MediaTime>;
			readonly startMouseX: number;
			readonly startMouseY: number;
			readonly startElementTime: MediaTime;
			readonly clickOffsetTime: MediaTime;
			readonly currentTime: MediaTime;
			readonly currentMouseX: number;
			readonly currentMouseY: number;
			readonly dropTarget: DropTarget | null;
	  };

export interface DropTarget {
	trackIndex: number;
	isNewTrack: boolean;
	insertPosition: "above" | "below" | null;
	xPosition: MediaTime;
	targetElement: { elementId: string; trackId: string } | null;
}

export interface ComputeDropTargetParams {
	elementType: ElementType;
	mouseX: number;
	mouseY: number;
	tracks: SceneTracks;
	playheadTime: MediaTime;
	isExternalDrop: boolean;
	elementDuration: MediaTime;
	pixelsPerSecond: number;
	zoomLevel: number;
	verticalDragDirection?: "up" | "down" | null;
	startTimeOverride?: MediaTime;
	excludeElementId?: string;
	targetElementTypes?: string[];
}
