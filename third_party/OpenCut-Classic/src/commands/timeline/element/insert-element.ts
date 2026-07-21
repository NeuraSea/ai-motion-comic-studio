import { Command, type CommandResult } from "../../base-command";
import { EditorCore } from "../../../ports/editor-core";
import { roundMediaTime } from "../../../ports/media-time";
import type {
	CreateTimelineElement,
	SceneTracks,
	TimelineElement,
	TrackType,
} from "../../../ports/timeline";
import { applyPlacement } from "../../../timeline/placement/apply";
import {
	validateElementTrackCompatibility,
} from "../../../timeline/placement/command-ports";
import { canElementGoOnTrack } from "../../../timeline/placement/compatibility";
import { resolveTrackPlacement } from "../../../timeline/placement/resolve";
import { generateUUID } from "../../../utils/id";

type InsertElementPlacement =
	| { mode: "explicit"; trackId: string }
	| { mode: "auto"; trackType?: TrackType; insertIndex?: number };

export interface InsertElementParams {
	element: CreateTimelineElement;
	placement: InsertElementPlacement;
}

export class InsertElementCommand extends Command {
	private elementId: string;
	private savedState: SceneTracks | null = null;
	private targetTrackId: string | null = null;

	constructor({ element, placement }: InsertElementParams) {
		super();
		this.elementId = generateUUID();
		this.element = element;
		this.placement = placement;
	}

	private element: CreateTimelineElement;
	private placement: InsertElementPlacement;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		if (!this.validateElementBasics({ element: this.element })) {
			return;
		}

		const newElement = this.buildElement({ element: this.element });
		const updateResult = this.applyPlacementResult({
			tracks: this.savedState,
			element: newElement,
		});

		if (!updateResult) {
			return;
		}

		const { updatedTracks, targetTrackId } = updateResult;
		this.targetTrackId = targetTrackId;
		editor.timeline.updateTracks(updatedTracks);

		return {
			selection: {
				selectedElements: [
					{ trackId: targetTrackId, elementId: this.elementId },
				],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			},
		};
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getElementId(): string {
		return this.elementId;
	}

	getTrackId(): string | null {
		return this.targetTrackId;
	}

	private buildElement({
		element,
	}: {
		element: CreateTimelineElement;
	}): TimelineElement {
		return {
			...element,
			id: this.elementId,
			startTime: element.startTime,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			duration: element.duration,
		} as TimelineElement;
	}

	private validateElementBasics({
		element,
	}: {
		element: CreateTimelineElement;
	}): boolean {
		if (
			(element.type === "video" ||
				element.type === "image" ||
				(element.type === "audio" && element.sourceType === "upload")) &&
			typeof element.mediaId !== "string"
		) {
			return false;
		}

		if (
			element.type === "audio" &&
			element.sourceType === "library" &&
			typeof element.sourceUrl !== "string"
		) {
			return false;
		}

		if (element.type === "sticker" && typeof element.stickerId !== "string") {
			return false;
		}

		if (
			element.type === "graphic" &&
			typeof element.definitionId !== "string"
		) {
			return false;
		}

		if (
			element.type === "text" &&
			(typeof element.params.content !== "string" ||
				element.params.content.length === 0)
		) {
			return false;
		}

		if (element.type === "effect" && typeof element.effectType !== "string") {
			return false;
		}

		return true;
	}

	private applyPlacementResult({
		tracks,
		element,
	}: {
		tracks: SceneTracks;
		element: TimelineElement;
	}): { updatedTracks: SceneTracks; targetTrackId: string } | null {
		const placement = this.placement;

		if (
			placement.mode === "auto" &&
			placement.trackType &&
			!canElementGoOnTrack({
				elementType: element.type,
				trackType: placement.trackType,
			})
		) {
			return null;
		}

		const placementResult = resolveTrackPlacement({
			tracks,
			...(placement.mode === "auto" && placement.trackType
				? { trackType: placement.trackType }
				: { elementType: element.type }),
			timeSpans: [
				{
					startTime: element.startTime,
					duration: element.duration,
				},
			],
			strategy:
				placement.mode === "explicit"
					? { type: "explicit", trackId: placement.trackId }
					: { type: "firstAvailable" },
		});
		if (!placementResult) {
			if (placement.mode === "explicit") {
				const targetTrack =
					tracks.main.id === placement.trackId
						? tracks.main
						: (tracks.overlay.find(
								(track) => track.id === placement.trackId,
							) ??
							tracks.audio.find(
								(track) => track.id === placement.trackId,
							));
				if (targetTrack) {
					validateElementTrackCompatibility({
						element,
						track: targetTrack,
					});
				}
			}

			return null;
		}

		const elementToPlace =
			placementResult.kind === "existingTrack"
				? {
						...element,
						startTime:
							placementResult.adjustedStartTime !== undefined
								? roundMediaTime({
										time: placementResult.adjustedStartTime,
									})
								: element.startTime,
					}
				: element;

		return applyPlacement({
			tracks,
			placementResult,
			elements: [elementToPlace],
			newTrackInsertIndexOverride:
				placement.mode === "auto" && typeof placement.insertIndex === "number"
					? placement.insertIndex
					: undefined,
		});
	}
}
