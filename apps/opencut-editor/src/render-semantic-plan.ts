import {
	parseCanonicalTimelineDocument,
	type CanonicalTimelineDocument,
	type CanonicalTimelineElement,
} from "./canonical-timeline-codec.js";
import {
	isTimelineElementHidden,
	isTimelineTrackHidden,
	projectTimelineMediaParticipation,
} from "./timeline-media-policy.js";

/**
 * v2 adds the opacity-fade compositor receipt, v3 adds the audited
 * rectangle/ellipse hard-mask receipt, v4 adds uniform still-image scale
 * motion, and v5 adds explicit inside/outside hard-mask polarity. Readers may
 * still replay older plans when they do not carry fields introduced by a
 * newer version; older workers reject a new plan instead of silently omitting
 * compositor semantics.
 */
export const RENDER_SEMANTIC_PLAN_VERSION = 5 as const;
export const RENDER_SEMANTIC_FRAME_RATE = 24 as const;
export const RENDER_SEMANTIC_DIALOGUE_DUCKED_LINEAR_GAIN = 0.35 as const;
export const RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS = 0.12 as const;
export const RENDER_SEMANTIC_SHORT_VIDEO_FILL_STRATEGY =
	"same-shot-locked-image-hold-v1" as const;
export const RENDER_SEMANTIC_OPACITY_FADE_VERSION = 1 as const;
export const RENDER_SEMANTIC_SHAPE_MASK_VERSION = 2 as const;
export const RENDER_SEMANTIC_UNIFORM_SCALE_MOTION_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_SUBTITLE_TEXT_LENGTH = 10_000;
const MAX_VISUAL_CLIPS = 1_000;
const MAX_AUDIO_CLIPS = 256;
const MAX_TOTAL_FRAMES = RENDER_SEMANTIC_FRAME_RATE * 60 * 60 * 6;
const SHA256 = /^[0-9a-f]{64}$/i;

export type RenderSemanticAspectRatio = "16:9" | "9:16" | "1:1";
export type RenderSemanticMediaType = "image" | "video" | "audio";
export type RenderSemanticFit = "cover" | "contain";
export type RenderSemanticAudioRole = "dialogue" | "bgm" | "sfx";

/**
 * Immutable media identity supplied by the trusted asset repository. The
 * compiler never resolves URLs or paths and never re-reads mutable asset rows.
 */
export interface RenderSemanticAssetBinding {
	readonly assetId: string;
	readonly version: number;
	readonly checksum: string;
	readonly mediaType: RenderSemanticMediaType;
	/** Required for video/audio and forbidden for still images. */
	readonly sourceDurationFrames?: number;
	/** Immutable repository classification; canonical params may only agree. */
	readonly audioRole?: RenderSemanticAudioRole;
}

export interface CompileRenderSemanticPlanInput {
	readonly timelineDocument: unknown;
	readonly timelineDocumentId: string;
	readonly timelineRevisionId: string;
	readonly storyRevisionId: string;
	readonly aspectRatio: RenderSemanticAspectRatio;
	readonly assets: readonly RenderSemanticAssetBinding[];
}

export interface RenderSemanticAssetPin {
	readonly assetId: string;
	readonly version: number;
	readonly checksum: string;
	readonly sourceDurationFrames: number | null;
}

export interface RenderSemanticSourceTrim {
	readonly startFrame: number;
	readonly durationFrames: number;
	readonly endTrimFrames: number;
	readonly sourceDurationFrames: number;
}

export interface RenderSemanticVisualClip {
	readonly id: string;
	readonly mediaType: "image" | "video";
	readonly asset: RenderSemanticAssetPin;
	readonly startFrame: number;
	readonly durationFrames: number;
	readonly endFrameExclusive: number;
	readonly sourceTrim: RenderSemanticSourceTrim | null;
	readonly fit: RenderSemanticFit;
	/**
	 * The first audited OpenCut compositor slice. Only a frame-aligned scalar
	 * opacity channel that describes one fade-in and/or one fade-out is
	 * accepted. The optional field keeps previously persisted v1 plans
	 * renderable; newly compiled clips always set it when the channel exists.
	 */
	readonly opacityFade?: RenderSemanticVisualOpacityFade;
	/**
	 * Audited OpenCut shape-mask subset. The mask is evaluated in output-canvas
	 * coordinates after contain/cover fitting and before opacity. Its explicit
	 * polarity chooses whether the inside or outside is retained; discarded
	 * pixels are black in the current single-layer RSP compositor.
	 */
	readonly shapeMask?: RenderSemanticVisualShapeMask;
	/**
	 * Audited, centre-anchored Ken Burns subset for still images. Scale X and Y
	 * are compiled from two synchronized linear OpenCut channels so preview and
	 * export never infer or approximate transform semantics independently.
	 */
	readonly uniformScaleMotion?: RenderSemanticVisualUniformScaleMotion;
}

export interface RenderSemanticVisualFadeSegment {
	/** Clip-relative frame at which the linear transition starts. */
	readonly startFrame: number;
	readonly durationFrames: number;
}

export interface RenderSemanticVisualOpacityFade {
	readonly version: typeof RENDER_SEMANTIC_OPACITY_FADE_VERSION;
	readonly fadeIn: RenderSemanticVisualFadeSegment | null;
	readonly fadeOut: RenderSemanticVisualFadeSegment | null;
}

export type RenderSemanticVisualShapeMaskType = "rectangle" | "ellipse";

interface RenderSemanticVisualShapeMaskBase {
	readonly type: RenderSemanticVisualShapeMaskType;
	/** Offset from canvas centre, in canvas-width / canvas-height units. */
	readonly centerX: number;
	readonly centerY: number;
	/** Shape dimensions, in canvas-width / canvas-height units. */
	readonly width: number;
	readonly height: number;
}

/** Legacy RSP v3/v4 receipt. Its polarity is always keep-inside. */
export interface RenderSemanticVisualShapeMaskV1
	extends RenderSemanticVisualShapeMaskBase {
	readonly version: 1;
}

/** RSP v5 receipt with explicit, renderer-neutral hard-mask polarity. */
export interface RenderSemanticVisualShapeMaskV2
	extends RenderSemanticVisualShapeMaskBase {
	readonly version: typeof RENDER_SEMANTIC_SHAPE_MASK_VERSION;
	/** False keeps pixels inside the shape; true keeps pixels outside it. */
	readonly inverted: boolean;
}

export type RenderSemanticVisualShapeMask =
	| RenderSemanticVisualShapeMaskV1
	| RenderSemanticVisualShapeMaskV2;

export interface RenderSemanticVisualShapeMaskGeometry {
	readonly centerX: number;
	readonly centerY: number;
	readonly width: number;
	readonly height: number;
}

export interface RenderSemanticVisualUniformScaleMotion {
	readonly version: typeof RENDER_SEMANTIC_UNIFORM_SCALE_MOTION_VERSION;
	readonly startFrame: 0;
	readonly durationFrames: number;
	readonly fromScale: number;
	readonly toScale: number;
	readonly anchorX: 0.5;
	readonly anchorY: 0.5;
}

/**
 * Manju-owned provenance for an explicitly approved short-video fill. The
 * OpenCut element keeps the intended edit-point duration, while the shared
 * semantic compiler renders the immutable source video first and only then
 * holds a locked image from the same Story shot. Consumers must never infer
 * this policy merely because a video happens to be short.
 */
export interface RenderSemanticShortVideoFill {
	readonly version: 1;
	readonly strategy: typeof RENDER_SEMANTIC_SHORT_VIDEO_FILL_STRATEGY;
	readonly fallbackAssetId: string;
	readonly storySceneId: string;
	readonly storyShotId: string;
	readonly sourceRevisionId: string;
	readonly sourceDurationTicks: number;
	readonly targetDurationTicks: number;
	readonly appliedByOpenCut: boolean;
	readonly appliedPlanHash: string | null;
}

export interface RenderSemanticDialogueWindow {
	readonly triggerAudioClipIds: readonly string[];
	readonly startFrame: number;
	readonly endFrameExclusive: number;
}

export interface RenderSemanticDuckingWindow
	extends RenderSemanticDialogueWindow {
	readonly duckedLinearGain: typeof RENDER_SEMANTIC_DIALOGUE_DUCKED_LINEAR_GAIN;
	readonly attackSeconds: typeof RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS;
	readonly releaseSeconds: typeof RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS;
}

export interface RenderSemanticAudioClip {
	readonly id: string;
	readonly asset: RenderSemanticAssetPin;
	readonly startFrame: number;
	readonly durationFrames: number;
	readonly endFrameExclusive: number;
	readonly sourceTrim: RenderSemanticSourceTrim;
	readonly linearGain: number;
	readonly fadeInSeconds: number;
	readonly fadeOutSeconds: number;
	readonly role: RenderSemanticAudioRole;
	/** Present only on BGM clips and clipped by temporal intersection. */
	readonly duckingWindows: readonly RenderSemanticDuckingWindow[];
}

export interface RenderSemanticSubtitleCue {
	readonly id: string;
	readonly startFrame: number;
	readonly durationFrames: number;
	readonly endFrameExclusive: number;
	readonly text: string;
}

export interface RenderSemanticAudioMix {
	readonly dialogueDucking: {
		readonly triggerRole: "dialogue";
		readonly targetRole: "bgm";
		readonly duckedLinearGain: typeof RENDER_SEMANTIC_DIALOGUE_DUCKED_LINEAR_GAIN;
		readonly attackSeconds: typeof RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS;
		readonly releaseSeconds: typeof RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS;
		readonly mergedDialogueWindows: readonly RenderSemanticDialogueWindow[];
	};
}

export interface RenderSemanticPlan {
	readonly version: 1 | 2 | 3 | 4 | typeof RENDER_SEMANTIC_PLAN_VERSION;
	readonly timelineDocumentId: string;
	readonly timelineRevisionId: string;
	readonly storyRevisionId: string;
	readonly upstreamCommit: string;
	readonly ticksPerSecond: number;
	readonly frameRate: typeof RENDER_SEMANTIC_FRAME_RATE;
	readonly aspectRatio: RenderSemanticAspectRatio;
	readonly totalFrames: number;
	readonly visualClips: readonly RenderSemanticVisualClip[];
	readonly audioClips: readonly RenderSemanticAudioClip[];
	readonly subtitleCues: readonly RenderSemanticSubtitleCue[];
	readonly audioMix: RenderSemanticAudioMix;
}

export type RenderSemanticPlanErrorCode =
	| "ASSET_BINDING_INVALID"
	| "ASSET_BINDING_MISSING"
	| "INVALID_INPUT"
	| "INVALID_TIMELINE"
	| "UNSUPPORTED_TIMELINE";

export class RenderSemanticPlanError extends Error {
	constructor(
		readonly code: RenderSemanticPlanErrorCode,
		readonly path: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(`${path}: ${message}`, options);
		this.name = "RenderSemanticPlanError";
	}
}

interface NormalizedAssetBinding extends RenderSemanticAssetBinding {
	assetId: string;
	checksum: string;
}

interface LocatedElement {
	track: CanonicalTimelineDocument["tracks"]["main"];
	element: CanonicalTimelineElement;
	path: string;
}

const VISUAL_ANIMATION_CHANNEL_KEYS = new Set([
	"opacity",
	"transform.scaleX",
	"transform.scaleY",
]);

const VISUAL_PARAM_KEYS = new Set([
	"audioRole",
	"fadeInSeconds",
	"fadeOutSeconds",
	"fit",
	"shotId",
	"sourceRevisionId",
	"storyAssetId",
	"storySceneId",
	"storyShotId",
	"volume",
]);

const AUDIO_PARAM_KEYS = new Set([
	"audioRole",
	"dialogueLineId",
	"fadeInSeconds",
	"fadeOutSeconds",
	"sourceRevisionId",
	"storyDialogueLineId",
	"storyManagedAssetId",
	"storySceneId",
	"storyShotId",
	"volume",
]);

const SUBTITLE_PARAM_KEYS = new Set([
	"attachmentId",
	"content",
	"dialogueLineId",
	"manjuRole",
	"sourceAudioElementId",
	"sourceCueIndex",
	"speechAssetId",
	"storySceneId",
	"storyShotId",
	"subtitleCueSetId",
	"text",
]);

function fail(
	code: RenderSemanticPlanErrorCode,
	path: string,
	message: string,
	cause?: unknown,
): never {
	throw new RenderSemanticPlanError(code, path, message, { cause });
}

function identifier(value: unknown, path: string): string {
	if (typeof value !== "string") fail("INVALID_INPUT", path, "must be a string");
	const normalized = value.trim();
	if (
		!normalized ||
		normalized !== value ||
		normalized.length > MAX_IDENTIFIER_LENGTH ||
		/[\u0000-\u001f\u007f]/.test(normalized)
	) {
		fail("INVALID_INPUT", path, "must be a trimmed, non-empty identifier");
	}
	return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const SHORT_VIDEO_FILL_KEYS = new Set([
	"version",
	"strategy",
	"fallbackAssetId",
	"storySceneId",
	"storyShotId",
	"sourceRevisionId",
	"sourceDurationTicks",
	"targetDurationTicks",
	"appliedByOpenCut",
	"appliedPlanHash",
]);

/** Stable synthetic clip ID used by preview, browser export and FFmpeg. */
export function shortVideoFillClipId(elementId: string): string {
	return `${elementId}::${RENDER_SEMANTIC_SHORT_VIDEO_FILL_STRATEGY}`;
}

/**
 * Parse only explicit provenance. This helper is also used by trusted media
 * adapters to collect the fallback binding before compilation.
 */
export function shortVideoFillDescriptor(
	element: CanonicalTimelineElement,
	path = "$.timelineElement",
): RenderSemanticShortVideoFill | null {
	const raw = element.manju?.shortVideoFill;
	if (raw === undefined) return null;
	if (!isPlainObject(raw) || Object.keys(raw).some((key) => !SHORT_VIDEO_FILL_KEYS.has(key))
		|| Object.keys(raw).length !== SHORT_VIDEO_FILL_KEYS.size) {
		fail("INVALID_TIMELINE", `${path}.manju.shortVideoFill`, "has an invalid shape");
	}
	if (raw.version !== 1) {
		fail("INVALID_TIMELINE", `${path}.manju.shortVideoFill.version`, "must be 1");
	}
	if (raw.strategy !== RENDER_SEMANTIC_SHORT_VIDEO_FILL_STRATEGY) {
		fail("INVALID_TIMELINE", `${path}.manju.shortVideoFill.strategy`, "is unsupported");
	}
	const sourceDurationTicks = raw.sourceDurationTicks;
	const targetDurationTicks = raw.targetDurationTicks;
	if (!Number.isSafeInteger(sourceDurationTicks) || (sourceDurationTicks as number) < 1) {
		fail("INVALID_TIMELINE", `${path}.manju.shortVideoFill.sourceDurationTicks`, "must be a positive safe integer");
	}
	if (!Number.isSafeInteger(targetDurationTicks)
		|| (targetDurationTicks as number) <= (sourceDurationTicks as number)) {
		fail(
			"INVALID_TIMELINE",
			`${path}.manju.shortVideoFill.targetDurationTicks`,
			"must be a safe integer greater than sourceDurationTicks",
		);
	}
	if (typeof raw.appliedByOpenCut !== "boolean") {
		fail("INVALID_TIMELINE", `${path}.manju.shortVideoFill.appliedByOpenCut`, "must be boolean");
	}
	if (raw.appliedPlanHash !== null
		&& (typeof raw.appliedPlanHash !== "string" || !SHA256.test(raw.appliedPlanHash))) {
		fail("INVALID_TIMELINE", `${path}.manju.shortVideoFill.appliedPlanHash`, "must be null or a SHA-256 digest");
	}
	if (raw.appliedByOpenCut !== (raw.appliedPlanHash !== null)) {
		fail(
			"INVALID_TIMELINE",
			`${path}.manju.shortVideoFill`,
			"applied state and plan hash must agree",
		);
	}
	return {
		version: 1,
		strategy: RENDER_SEMANTIC_SHORT_VIDEO_FILL_STRATEGY,
		fallbackAssetId: identifier(raw.fallbackAssetId, `${path}.manju.shortVideoFill.fallbackAssetId`),
		storySceneId: identifier(raw.storySceneId, `${path}.manju.shortVideoFill.storySceneId`),
		storyShotId: identifier(raw.storyShotId, `${path}.manju.shortVideoFill.storyShotId`),
		sourceRevisionId: identifier(raw.sourceRevisionId, `${path}.manju.shortVideoFill.sourceRevisionId`),
		sourceDurationTicks: sourceDurationTicks as number,
		targetDurationTicks: targetDurationTicks as number,
		appliedByOpenCut: raw.appliedByOpenCut,
		appliedPlanHash: raw.appliedPlanHash as string | null,
	};
}

function positiveInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		fail("ASSET_BINDING_INVALID", path, "must be a positive safe integer");
	}
	return value as number;
}

function deepFreeze<T>(value: T): Readonly<T> {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child);
		}
		Object.freeze(value);
	}
	return value;
}

function assetBindings(
	values: readonly RenderSemanticAssetBinding[],
): Map<string, NormalizedAssetBinding> {
	if (!Array.isArray(values)) fail("INVALID_INPUT", "$.assets", "must be an array");
	const result = new Map<string, NormalizedAssetBinding>();
	values.forEach((value, index) => {
		const path = `$.assets[${index}]`;
		if (!value || typeof value !== "object") {
			fail("ASSET_BINDING_INVALID", path, "must be an object");
		}
		const assetId = identifier(value.assetId, `${path}.assetId`);
		if (result.has(assetId)) {
			fail("ASSET_BINDING_INVALID", `${path}.assetId`, `duplicates ${assetId}`);
		}
		const version = positiveInteger(value.version, `${path}.version`);
		if (typeof value.checksum !== "string" || !SHA256.test(value.checksum)) {
			fail("ASSET_BINDING_INVALID", `${path}.checksum`, "must be a SHA-256 hex digest");
		}
		if (value.mediaType !== "image" && value.mediaType !== "video" && value.mediaType !== "audio") {
			fail("ASSET_BINDING_INVALID", `${path}.mediaType`, "must be image, video, or audio");
		}
		if (value.mediaType === "image") {
			if (value.sourceDurationFrames !== undefined) {
				fail("ASSET_BINDING_INVALID", `${path}.sourceDurationFrames`, "must be absent for images");
			}
			if (value.audioRole !== undefined) {
				fail("ASSET_BINDING_INVALID", `${path}.audioRole`, "must be absent for images");
			}
		} else {
			positiveInteger(value.sourceDurationFrames, `${path}.sourceDurationFrames`);
		}
		if (
			value.audioRole !== undefined &&
			value.audioRole !== "dialogue" &&
			value.audioRole !== "bgm" &&
			value.audioRole !== "sfx"
		) {
			fail("ASSET_BINDING_INVALID", `${path}.audioRole`, "must be dialogue, bgm, or sfx");
		}
		result.set(assetId, {
			...value,
			assetId,
			version,
			checksum: value.checksum.toLowerCase(),
		});
	});
	return result;
}

function requireAsset(
	assets: ReadonlyMap<string, NormalizedAssetBinding>,
	assetId: string,
	path: string,
): NormalizedAssetBinding {
	if (assetId.startsWith("manju:pending:")) {
		fail("ASSET_BINDING_MISSING", path, "contains an unresolved media binding");
	}
	const asset = assets.get(assetId);
	if (!asset) fail("ASSET_BINDING_MISSING", path, `has no immutable binding for ${assetId}`);
	return asset;
}

function assetPin(asset: NormalizedAssetBinding): RenderSemanticAssetPin {
	return {
		assetId: asset.assetId,
		version: asset.version,
		checksum: asset.checksum,
		sourceDurationFrames: asset.sourceDurationFrames ?? null,
	};
}

function frameForTicks(
	value: number,
	ticksPerSecond: number,
	path: string,
	minimum = 0,
): number {
	if (!Number.isSafeInteger(value) || value < minimum) {
		fail("INVALID_TIMELINE", path, `must be a safe integer >= ${minimum}`);
	}
	const numerator = value * RENDER_SEMANTIC_FRAME_RATE;
	if (!Number.isSafeInteger(numerator) || numerator % ticksPerSecond !== 0) {
		fail("INVALID_TIMELINE", path, "must align exactly to a 24 fps frame boundary");
	}
	return numerator / ticksPerSecond;
}

function assertAllowedParams(
	element: CanonicalTimelineElement,
	allowed: ReadonlySet<string>,
	path: string,
): void {
	for (const key of Object.keys(element.params)) {
		if (!allowed.has(key)) {
			fail(
				"UNSUPPORTED_TIMELINE",
				`${path}.params.${key}`,
				"has no RenderSemanticPlan meaning and cannot be silently ignored",
			);
		}
	}
}

function assertPlainComposition(
	element: CanonicalTimelineElement,
	path: string,
	options: {
		allowedAnimationChannels?: ReadonlySet<string>;
		allowShapeMask?: boolean;
	} = {},
): void {
	if (element.animations) {
		for (const channel of Object.keys(element.animations)) {
			if (!options.allowedAnimationChannels?.has(channel)) {
				fail(
					"UNSUPPORTED_TIMELINE",
					`${path}.animations.${channel}`,
					"has no RenderSemanticPlan meaning and cannot be silently ignored",
				);
			}
		}
	}
	if ((element.effects?.length ?? 0) > 0) {
		fail("UNSUPPORTED_TIMELINE", `${path}.effects`, "effects are not supported");
	}
	if (!options.allowShapeMask && "masks" in element && (element.masks?.length ?? 0) > 0) {
		fail("UNSUPPORTED_TIMELINE", `${path}.masks`, "masks are not supported");
	}
	if (element.retime !== undefined && element.retime.rate !== 1) {
		fail("UNSUPPORTED_TIMELINE", `${path}.retime`, "retiming is not supported");
	}
}

function exactObjectKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const keys = Object.keys(value);
	return required.every((key) => keys.includes(key))
		&& keys.every((key) => required.includes(key) || optional.includes(key));
}

/**
 * Compile the deliberately narrow OpenCut opacity-keyframe subset that both
 * browser compositors and FFmpeg can reproduce exactly. The composition-level
 * channel allowlist rejects unknown channels; this channel compiler therefore
 * deliberately ignores the separately audited uniform-scale pair. Handles,
 * interpolation modes, fractional opacity and repeated direction changes are
 * rejected rather than approximated.
 */
export function compileRenderSemanticVisualOpacityFade(input: {
	animations?: Record<string, unknown>;
	duration: number;
	ticksPerSecond: number;
	path?: string;
}): RenderSemanticVisualOpacityFade | undefined {
	const path = input.path ?? "$.timelineElement";
	const animations = input.animations;
	if (!animations || animations.opacity === undefined) return undefined;
	const rawChannel = animations.opacity;
	if (!isPlainObject(rawChannel) || !exactObjectKeys(rawChannel, ["keys"], ["extrapolation"])) {
		fail("INVALID_TIMELINE", `${path}.animations.opacity`, "has an invalid channel shape");
	}
	if (rawChannel.extrapolation !== undefined) {
		const extrapolation = rawChannel.extrapolation;
		if (!isPlainObject(extrapolation)
			|| !exactObjectKeys(extrapolation, ["before", "after"])
			|| extrapolation.before !== "hold"
			|| extrapolation.after !== "hold") {
			fail(
				"UNSUPPORTED_TIMELINE",
				`${path}.animations.opacity.extrapolation`,
				"must hold before and after the key range",
			);
		}
	}
	if (!Array.isArray(rawChannel.keys) || rawChannel.keys.length < 2 || rawChannel.keys.length > 4) {
		fail(
			"UNSUPPORTED_TIMELINE",
			`${path}.animations.opacity.keys`,
			"must contain 2 to 4 keys for one fade-in and/or one fade-out",
		);
	}
	const clipDurationFrames = frameForTicks(
		input.duration,
		input.ticksPerSecond,
		`${path}.duration`,
		1,
	);
	const keys = rawChannel.keys.map((rawKey, index) => {
		const keyPath = `${path}.animations.opacity.keys[${index}]`;
		if (!isPlainObject(rawKey)
			|| !exactObjectKeys(
				rawKey,
				["id", "time", "value", "segmentToNext", "tangentMode"],
				["leftHandle", "rightHandle"],
			)) {
			fail("UNSUPPORTED_TIMELINE", keyPath, "has unsupported fields or is malformed");
		}
		if (rawKey.leftHandle !== undefined || rawKey.rightHandle !== undefined) {
			fail("UNSUPPORTED_TIMELINE", keyPath, "Bezier handles are not supported");
		}
		identifier(rawKey.id, `${keyPath}.id`);
		if (rawKey.value !== 0 && rawKey.value !== 1) {
			fail(
				"UNSUPPORTED_TIMELINE",
				`${keyPath}.value`,
				"must be exactly 0 or 1 in the opacity-fade slice",
			);
		}
		if (rawKey.segmentToNext !== "linear" || rawKey.tangentMode !== "flat") {
			fail(
				"UNSUPPORTED_TIMELINE",
				keyPath,
				"must use linear interpolation with flat tangents",
			);
		}
		if (typeof rawKey.time !== "number") {
			fail("INVALID_TIMELINE", `${keyPath}.time`, "must be a numeric MediaTime");
		}
		const timeFrame = frameForTicks(rawKey.time, input.ticksPerSecond, `${keyPath}.time`);
		if (timeFrame > clipDurationFrames) {
			fail("INVALID_TIMELINE", `${keyPath}.time`, "cannot exceed the clip duration");
		}
		return { timeFrame, value: rawKey.value as 0 | 1 };
	});
	for (let index = 1; index < keys.length; index += 1) {
		if (keys[index]!.timeFrame <= keys[index - 1]!.timeFrame) {
			fail(
				"INVALID_TIMELINE",
				`${path}.animations.opacity.keys[${index}].time`,
				"must be strictly increasing",
			);
		}
	}

	let fadeIn: RenderSemanticVisualFadeSegment | null = null;
	let fadeOut: RenderSemanticVisualFadeSegment | null = null;
	for (let index = 0; index < keys.length - 1; index += 1) {
		const current = keys[index]!;
		const next = keys[index + 1]!;
		if (current.value === next.value) continue;
		const segment = {
			startFrame: current.timeFrame,
			durationFrames: next.timeFrame - current.timeFrame,
		};
		if (current.value === 0 && next.value === 1) {
			if (fadeIn || fadeOut) {
				fail(
					"UNSUPPORTED_TIMELINE",
					`${path}.animations.opacity.keys`,
					"cannot fade back in after another opacity transition",
				);
			}
			fadeIn = segment;
		} else {
			if (fadeOut) {
				fail(
					"UNSUPPORTED_TIMELINE",
					`${path}.animations.opacity.keys`,
					"cannot contain more than one fade-out",
				);
			}
			fadeOut = segment;
		}
	}
	if (!fadeIn && !fadeOut) {
		if (keys.every((key) => key.value === 1)) {
			// OpenCut split can retain a semantically neutral all-opaque channel
			// on one side. Canonicalizing that exact no-op is lossless.
			return undefined;
		}
		fail(
			"UNSUPPORTED_TIMELINE",
			`${path}.animations.opacity.keys`,
			"must contain at least one visible opacity transition",
		);
	}
	if (fadeIn && fadeOut && fadeIn.startFrame + fadeIn.durationFrames > fadeOut.startFrame) {
		fail(
			"UNSUPPORTED_TIMELINE",
			`${path}.animations.opacity.keys`,
			"fade-in and fade-out cannot overlap",
		);
	}
	return {
		version: RENDER_SEMANTIC_OPACITY_FADE_VERSION,
		fadeIn,
		fadeOut,
	};
}

interface ParsedUniformScaleChannel {
	readonly start: { readonly timeFrame: number; readonly value: number };
	readonly end: { readonly timeFrame: number; readonly value: number };
}

function uniformScaleChannel(
	rawChannel: unknown,
	channelPath: string,
	ticksPerSecond: number,
	clipDurationFrames: number,
): ParsedUniformScaleChannel {
	if (!isPlainObject(rawChannel)
		|| !exactObjectKeys(rawChannel, ["keys", "extrapolation"])) {
		fail(
			"UNSUPPORTED_TIMELINE",
			channelPath,
			"must contain exactly two keys and hold extrapolation",
		);
	}
	const extrapolation = rawChannel.extrapolation;
	if (!isPlainObject(extrapolation)
		|| !exactObjectKeys(extrapolation, ["before", "after"])
		|| extrapolation.before !== "hold"
		|| extrapolation.after !== "hold") {
		fail(
			"UNSUPPORTED_TIMELINE",
			`${channelPath}.extrapolation`,
			"must hold before and after the key range",
		);
	}
	if (!Array.isArray(rawChannel.keys) || rawChannel.keys.length !== 2) {
		fail(
			"UNSUPPORTED_TIMELINE",
			`${channelPath}.keys`,
			"must contain exactly two keys",
		);
	}
	const keys = rawChannel.keys.map((rawKey, index) => {
		const keyPath = `${channelPath}.keys[${index}]`;
		if (!isPlainObject(rawKey)
			|| !exactObjectKeys(
				rawKey,
				["id", "time", "value", "segmentToNext", "tangentMode"],
				["leftHandle", "rightHandle"],
			)) {
			fail("UNSUPPORTED_TIMELINE", keyPath, "has unsupported fields or is malformed");
		}
		if (rawKey.leftHandle !== undefined || rawKey.rightHandle !== undefined) {
			fail("UNSUPPORTED_TIMELINE", keyPath, "Bezier handles are not supported");
		}
		identifier(rawKey.id, `${keyPath}.id`);
		if (rawKey.segmentToNext !== "linear" || rawKey.tangentMode !== "flat") {
			fail(
				"UNSUPPORTED_TIMELINE",
				keyPath,
				"must use linear interpolation with flat tangents",
			);
		}
		if (typeof rawKey.time !== "number") {
			fail("INVALID_TIMELINE", `${keyPath}.time`, "must be a numeric MediaTime");
		}
		const timeFrame = frameForTicks(rawKey.time, ticksPerSecond, `${keyPath}.time`);
		if (timeFrame > clipDurationFrames) {
			fail("INVALID_TIMELINE", `${keyPath}.time`, "cannot exceed the clip duration");
		}
		if (typeof rawKey.value !== "number"
			|| !Number.isFinite(rawKey.value)
			|| rawKey.value < 1
			|| rawKey.value > 1.2) {
			fail(
				"UNSUPPORTED_TIMELINE",
				`${keyPath}.value`,
				"must be a finite scale from 1.00 to 1.20",
			);
		}
		const value = Number(rawKey.value.toFixed(6));
		return { timeFrame, value: Object.is(value, -0) ? 0 : value };
	});
	if (keys[0]!.timeFrame !== 0 || keys[1]!.timeFrame !== clipDurationFrames) {
		fail(
			"UNSUPPORTED_TIMELINE",
			`${channelPath}.keys`,
			"must start at clip frame 0 and end at the clip duration",
		);
	}
	return { start: keys[0]!, end: keys[1]! };
}

/**
 * Compile the audited OpenCut uniform scale subset. Scale X/Y must be two
 * synchronized, frame-aligned, centre-anchored linear channels spanning the
 * entire still-image clip. Opacity may coexist and is compiled independently.
 */
export function compileRenderSemanticVisualUniformScaleMotion(input: {
	animations?: Record<string, unknown>;
	duration: number;
	ticksPerSecond: number;
	path?: string;
}): RenderSemanticVisualUniformScaleMotion | undefined {
	const path = input.path ?? "$.timelineElement";
	const animations = input.animations;
	const rawScaleX = animations?.["transform.scaleX"];
	const rawScaleY = animations?.["transform.scaleY"];
	if (rawScaleX === undefined && rawScaleY === undefined) return undefined;
	if (rawScaleX === undefined || rawScaleY === undefined) {
		fail(
			"UNSUPPORTED_TIMELINE",
			`${path}.animations`,
			"uniform scale requires both transform.scaleX and transform.scaleY",
		);
	}
	const clipDurationFrames = frameForTicks(
		input.duration,
		input.ticksPerSecond,
		`${path}.duration`,
		1,
	);
	const scaleX = uniformScaleChannel(
		rawScaleX,
		`${path}.animations.transform.scaleX`,
		input.ticksPerSecond,
		clipDurationFrames,
	);
	const scaleY = uniformScaleChannel(
		rawScaleY,
		`${path}.animations.transform.scaleY`,
		input.ticksPerSecond,
		clipDurationFrames,
	);
	if (
		scaleX.start.timeFrame !== scaleY.start.timeFrame
		|| scaleX.end.timeFrame !== scaleY.end.timeFrame
		|| scaleX.start.value !== scaleY.start.value
		|| scaleX.end.value !== scaleY.end.value
	) {
		fail(
			"UNSUPPORTED_TIMELINE",
			`${path}.animations`,
			"transform.scaleX and transform.scaleY must have synchronized times and values",
		);
	}
	if (scaleX.start.value === scaleX.end.value) {
		fail(
			"UNSUPPORTED_TIMELINE",
			`${path}.animations`,
			"uniform scale must change monotonically across the clip",
		);
	}
	return {
		version: RENDER_SEMANTIC_UNIFORM_SCALE_MOTION_VERSION,
		startFrame: 0,
		durationFrames: clipDurationFrames,
		fromScale: scaleX.start.value,
		toScale: scaleX.end.value,
		anchorX: 0.5,
		anchorY: 0.5,
	};
}

function maskNumber(
	value: unknown,
	path: string,
	minimum: number,
	maximum: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)
		|| value < minimum || value > maximum) {
		fail(
			"INVALID_TIMELINE",
			path,
			`must be a finite number from ${minimum} to ${maximum}`,
		);
	}
	const rounded = Number(value.toFixed(6));
	return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Compile the cross-renderer OpenCut hard-mask subset. We intentionally accept
 * only one axis-aligned, hard-edged rectangle or ellipse with explicit
 * inside/outside polarity and no stroke. Feather, rotation, scale, multiple
 * masks and unknown mask types are rejected rather than approximated by one
 * renderer.
 */
export function compileRenderSemanticVisualShapeMask(input: {
	masks?: readonly Record<string, unknown>[];
	path?: string;
}): RenderSemanticVisualShapeMask | undefined {
	const path = input.path ?? "$.timelineElement";
	const masks = input.masks;
	if (masks === undefined) return undefined;
	if (!Array.isArray(masks)) {
		fail("INVALID_TIMELINE", `${path}.masks`, "must be an array");
	}
	if (masks.length === 0) return undefined;
	if (masks.length !== 1) {
		fail(
			"UNSUPPORTED_TIMELINE",
			`${path}.masks`,
			"the audited compositor supports exactly one rectangle or ellipse mask",
		);
	}
	const raw = masks[0];
	const maskPath = `${path}.masks[0]`;
	if (!isPlainObject(raw) || !exactObjectKeys(raw, ["id", "type", "params"])) {
		fail("INVALID_TIMELINE", maskPath, "has an invalid OpenCut mask shape");
	}
	identifier(raw.id, `${maskPath}.id`);
	if (raw.type !== "rectangle" && raw.type !== "ellipse") {
		fail(
			"UNSUPPORTED_TIMELINE",
			`${maskPath}.type`,
			"only rectangle and ellipse masks are supported",
		);
	}
	const params = raw.params;
	if (!isPlainObject(params) || !exactObjectKeys(params, [
		"feather",
		"inverted",
		"strokeColor",
		"strokeWidth",
		"strokeAlign",
		"centerX",
		"centerY",
		"width",
		"height",
		"rotation",
		"scale",
	])) {
		fail("INVALID_TIMELINE", `${maskPath}.params`, "has an invalid OpenCut box-mask shape");
	}
	if (params.feather !== 0) {
		fail("UNSUPPORTED_TIMELINE", `${maskPath}.params.feather`, "feather is not yet supported");
	}
	if (typeof params.inverted !== "boolean") {
		fail("INVALID_TIMELINE", `${maskPath}.params.inverted`, "must be a boolean");
	}
	if (params.strokeWidth !== 0
		|| params.strokeColor !== "#ffffff"
		|| params.strokeAlign !== "center") {
		fail("UNSUPPORTED_TIMELINE", `${maskPath}.params`, "mask strokes are not yet supported");
	}
	if (params.rotation !== 0) {
		fail("UNSUPPORTED_TIMELINE", `${maskPath}.params.rotation`, "rotated masks are not yet supported");
	}
	if (params.scale !== 1) {
		fail("UNSUPPORTED_TIMELINE", `${maskPath}.params.scale`, "mask scale must be exactly 1");
	}
	return {
		version: RENDER_SEMANTIC_SHAPE_MASK_VERSION,
		type: raw.type,
		inverted: params.inverted,
		centerX: maskNumber(params.centerX, `${maskPath}.params.centerX`, -1, 1),
		centerY: maskNumber(params.centerY, `${maskPath}.params.centerY`, -1, 1),
		width: maskNumber(params.width, `${maskPath}.params.width`, 0.01, 2),
		height: maskNumber(params.height, `${maskPath}.params.height`, 0.01, 2),
	};
}

/** Resolve OpenCut's normalized box-mask coordinates for any output canvas. */
export function renderSemanticVisualShapeMaskGeometry(
	mask: RenderSemanticVisualShapeMask,
	canvasWidth: number,
	canvasHeight: number,
): RenderSemanticVisualShapeMaskGeometry {
	if (!Number.isFinite(canvasWidth) || canvasWidth <= 0
		|| !Number.isFinite(canvasHeight) || canvasHeight <= 0) {
		throw new RangeError("shape-mask canvas dimensions must be positive finite numbers");
	}
	return {
		centerX: canvasWidth / 2 + mask.centerX * canvasWidth,
		centerY: canvasHeight / 2 + mask.centerY * canvasHeight,
		width: mask.width * canvasWidth,
		height: mask.height * canvasHeight,
	};
}

function fitFromElement(element: CanonicalTimelineElement, path: string): RenderSemanticFit {
	const fit = element.params.fit;
	if (fit === undefined || fit === "cover") return "cover";
	if (fit === "contain") return "contain";
	fail("INVALID_TIMELINE", `${path}.params.fit`, "must be cover or contain");
}

function sourceTrim(
	element: CanonicalTimelineElement,
	asset: NormalizedAssetBinding,
	ticksPerSecond: number,
	path: string,
): RenderSemanticSourceTrim {
	const sourceDurationFrames = positiveInteger(
		asset.sourceDurationFrames,
		`${path}.asset.sourceDurationFrames`,
	);
	const startFrame = frameForTicks(element.trimStart, ticksPerSecond, `${path}.trimStart`);
	const durationFrames = frameForTicks(element.duration, ticksPerSecond, `${path}.duration`, 1);
	const endTrimFrames = frameForTicks(element.trimEnd, ticksPerSecond, `${path}.trimEnd`);
	if (element.sourceDuration !== undefined) {
		const pinnedSourceDuration = frameForTicks(
			element.sourceDuration,
			ticksPerSecond,
			`${path}.sourceDuration`,
			1,
		);
		if (pinnedSourceDuration !== sourceDurationFrames) {
			fail(
				"INVALID_TIMELINE",
				`${path}.sourceDuration`,
				"does not match the immutable asset duration",
			);
		}
	}
	if (startFrame + durationFrames + endTrimFrames !== sourceDurationFrames) {
		fail(
			"INVALID_TIMELINE",
			path,
			"trimStart + duration + trimEnd must equal the immutable source duration",
		);
	}
	return { startFrame, durationFrames, endTrimFrames, sourceDurationFrames };
}

function linearGain(element: CanonicalTimelineElement, path: string): number {
	const value = element.params.volume ?? 1;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 4) {
		fail("INVALID_TIMELINE", `${path}.params.volume`, "must be a finite linear gain from 0 to 4");
	}
	return value;
}

function audioRole(
	element: CanonicalTimelineElement,
	asset: NormalizedAssetBinding,
	path: string,
): RenderSemanticAudioRole {
	const raw = element.params.audioRole;
	if (raw !== undefined && raw !== "dialogue" && raw !== "bgm" && raw !== "sfx") {
		fail("INVALID_TIMELINE", `${path}.params.audioRole`, "must be dialogue, bgm, or sfx");
	}
	const associatedDialogue =
		typeof element.params.dialogueLineId === "string" ||
		typeof element.params.storyDialogueLineId === "string";
	const candidates = new Set<RenderSemanticAudioRole>();
	if (raw !== undefined) candidates.add(raw);
	if (asset.audioRole !== undefined) candidates.add(asset.audioRole);
	if (associatedDialogue) candidates.add("dialogue");
	if (candidates.size !== 1) {
		fail(
			"INVALID_TIMELINE",
			`${path}.params.audioRole`,
			candidates.size === 0
				? "is required because the asset role is ambiguous"
				: "conflicts with immutable asset/dialogue provenance",
		);
	}
	return [...candidates][0]!;
}

function fades(
	element: CanonicalTimelineElement,
	durationFrames: number,
	path: string,
): { fadeInSeconds: number; fadeOutSeconds: number } {
	const durationSeconds = durationFrames / RENDER_SEMANTIC_FRAME_RATE;
	const read = (key: "fadeInSeconds" | "fadeOutSeconds"): number => {
		const value = element.params[key] ?? 0;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			fail("INVALID_TIMELINE", `${path}.params.${key}`, "must be a finite non-negative number");
		}
		if (value > durationSeconds) {
			fail("INVALID_TIMELINE", `${path}.params.${key}`, "cannot exceed the clip duration");
		}
		return value;
	};
	const fadeInSeconds = read("fadeInSeconds");
	const fadeOutSeconds = read("fadeOutSeconds");
	if (fadeInSeconds + fadeOutSeconds > durationSeconds) {
		fail("INVALID_TIMELINE", path, "fade-in and fade-out overlap");
	}
	return { fadeInSeconds, fadeOutSeconds };
}

function subtitleText(element: CanonicalTimelineElement, path: string): string {
	const normalized = (value: unknown): string | null => {
		if (typeof value !== "string") return null;
		const text = value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
		return text || null;
	};
	const text = normalized(element.params.text);
	const content = normalized(element.params.content);
	if (text && content && text !== content) {
		fail("INVALID_TIMELINE", `${path}.params`, "text and content disagree");
	}
	const result = text ?? content ?? normalized(element.name);
	if (!result) fail("INVALID_TIMELINE", path, "active subtitle has no text");
	if (result.length > MAX_SUBTITLE_TEXT_LENGTH) {
		fail("INVALID_TIMELINE", path, "subtitle text is too long");
	}
	return result;
}

function audioClip(
	element: CanonicalTimelineElement,
	asset: NormalizedAssetBinding,
	id: string,
	ticksPerSecond: number,
	path: string,
): Omit<RenderSemanticAudioClip, "duckingWindows"> {
	assertPlainComposition(element, path);
	const trim = sourceTrim(element, asset, ticksPerSecond, path);
	const startFrame = frameForTicks(element.startTime, ticksPerSecond, `${path}.startTime`);
	return {
		id,
		asset: assetPin(asset),
		startFrame,
		durationFrames: trim.durationFrames,
		endFrameExclusive: startFrame + trim.durationFrames,
		sourceTrim: trim,
		linearGain: linearGain(element, path),
		...fades(element, trim.durationFrames, path),
		role: audioRole(element, asset, path),
	};
}

function mergedDialogueWindows(
	clips: readonly Omit<RenderSemanticAudioClip, "duckingWindows">[],
): RenderSemanticDialogueWindow[] {
	type MutableDialogueWindow = {
		triggerAudioClipIds: string[];
		startFrame: number;
		endFrameExclusive: number;
	};
	const candidates = clips
		.filter((clip) => clip.role === "dialogue")
		.map((clip) => ({
			triggerAudioClipIds: [clip.id],
			startFrame: clip.startFrame,
			endFrameExclusive: clip.endFrameExclusive,
		}))
		.sort((left, right) => left.startFrame - right.startFrame || left.endFrameExclusive - right.endFrameExclusive);
	const merged: MutableDialogueWindow[] = [];
	const maximumHoldGap = Math.floor(
		2 * RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS * RENDER_SEMANTIC_FRAME_RATE,
	);
	for (const candidate of candidates) {
		const previous = merged.at(-1);
		if (previous && candidate.startFrame - previous.endFrameExclusive <= maximumHoldGap) {
			previous.endFrameExclusive = Math.max(previous.endFrameExclusive, candidate.endFrameExclusive);
			previous.triggerAudioClipIds.push(...candidate.triggerAudioClipIds);
		} else {
			merged.push({
				...candidate,
				triggerAudioClipIds: [...candidate.triggerAudioClipIds],
			});
		}
	}
	return merged;
}

function duckingWindowsForClip(
	clip: Omit<RenderSemanticAudioClip, "duckingWindows">,
	windows: readonly RenderSemanticDialogueWindow[],
): RenderSemanticDuckingWindow[] {
	if (clip.role !== "bgm") return [];
	const smoothingFrames =
		RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS * RENDER_SEMANTIC_FRAME_RATE;
	return windows
		.filter((window) => (
			window.endFrameExclusive + smoothingFrames > clip.startFrame &&
			window.startFrame - smoothingFrames < clip.endFrameExclusive
		))
		.map((window) => ({
			...window,
			triggerAudioClipIds: [...window.triggerAudioClipIds],
			duckedLinearGain: RENDER_SEMANTIC_DIALOGUE_DUCKED_LINEAR_GAIN,
			attackSeconds: RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS,
			releaseSeconds: RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS,
		}));
}

function validateFrameRate(document: CanonicalTimelineDocument): void {
	if (
		document.frameRate.numerator !== RENDER_SEMANTIC_FRAME_RATE ||
		document.frameRate.denominator !== 1
	) {
		fail("UNSUPPORTED_TIMELINE", "$.timelineDocument.frameRate", "must be exactly 24/1 fps");
	}
	if (document.ticksPerSecond % RENDER_SEMANTIC_FRAME_RATE !== 0) {
		fail("UNSUPPORTED_TIMELINE", "$.timelineDocument.ticksPerSecond", "cannot represent 24 fps exactly");
	}
}

function locatedVisuals(document: CanonicalTimelineDocument): LocatedElement[] {
	const tracks = [
		...document.tracks.overlay.filter((track) => track.type === "video"),
		document.tracks.main,
	];
	const active = tracks
		.map((track, trackIndex) => ({
			track,
			trackIndex,
			elements: track.elements.filter((element) => (
				projectTimelineMediaParticipation(track, element).visual
			)),
		}))
		.filter((entry) => entry.elements.length > 0);
	if (active.length === 0) {
		fail("INVALID_TIMELINE", "$.timelineDocument.tracks", "must contain an active visual track");
	}
	if (active.length > 1) {
		fail("UNSUPPORTED_TIMELINE", "$.timelineDocument.tracks", "multiple active visual layers are unsupported");
	}
	const entry = active[0]!;
	return entry.elements.map((element, elementIndex) => ({
		track: entry.track,
		element,
		path: `$.timelineDocument.tracks.visual[${entry.trackIndex}].elements[${elementIndex}]`,
	}));
}

function rejectUnsupportedTracks(document: CanonicalTimelineDocument): void {
	for (const [trackIndex, track] of document.tracks.overlay.entries()) {
		if (isTimelineTrackHidden(track) || (track.type !== "graphic" && track.type !== "effect")) continue;
		const active = track.elements.find((element) => !isTimelineElementHidden(track, element));
		if (active) {
			fail(
				"UNSUPPORTED_TIMELINE",
				`$.timelineDocument.tracks.overlay[${trackIndex}]`,
				`${track.type} rendering is unsupported`,
			);
		}
	}
}

/**
 * Compile one canonical, revision-pinned timeline into the renderer-neutral
 * semantics that preview and export consumers must agree on.
 */
export function compileRenderSemanticPlan(
	input: CompileRenderSemanticPlanInput,
): RenderSemanticPlan {
	const timelineDocumentId = identifier(input.timelineDocumentId, "$.timelineDocumentId");
	const timelineRevisionId = identifier(input.timelineRevisionId, "$.timelineRevisionId");
	const storyRevisionId = identifier(input.storyRevisionId, "$.storyRevisionId");
	if (input.aspectRatio !== "16:9" && input.aspectRatio !== "9:16" && input.aspectRatio !== "1:1") {
		fail("INVALID_INPUT", "$.aspectRatio", "must be 16:9, 9:16, or 1:1");
	}
	const assets = assetBindings(input.assets);
	let document: CanonicalTimelineDocument;
	try {
		document = parseCanonicalTimelineDocument(input.timelineDocument);
	} catch (cause) {
		fail("INVALID_TIMELINE", "$.timelineDocument", "is not a canonical OpenCut document", cause);
	}
	validateFrameRate(document);
	rejectUnsupportedTracks(document);

	const sourceVisuals = locatedVisuals(document).sort((left, right) => (
		left.element.startTime - right.element.startTime || left.element.id.localeCompare(right.element.id)
	));
	if (sourceVisuals.length > MAX_VISUAL_CLIPS) {
		fail("INVALID_TIMELINE", "$.timelineDocument.tracks", `has more than ${MAX_VISUAL_CLIPS} visual clips`);
	}
	let expectedStartFrame = 0;
	const audioWithoutDucking: Array<Omit<RenderSemanticAudioClip, "duckingWindows">> = [];
	const visualClips = sourceVisuals.flatMap(({ track, element, path }): RenderSemanticVisualClip[] => {
		if (element.type !== "image" && element.type !== "video") {
			fail("UNSUPPORTED_TIMELINE", `${path}.type`, "must be image or video");
		}
		assertPlainComposition(element, path, {
			allowedAnimationChannels: VISUAL_ANIMATION_CHANNEL_KEYS,
			allowShapeMask: true,
		});
		assertAllowedParams(element, VISUAL_PARAM_KEYS, path);
		const opacityFade = compileRenderSemanticVisualOpacityFade({
			animations: element.animations,
			duration: element.duration,
			ticksPerSecond: document.ticksPerSecond,
			path,
		});
		const uniformScaleMotion = compileRenderSemanticVisualUniformScaleMotion({
			animations: element.animations,
			duration: element.duration,
			ticksPerSecond: document.ticksPerSecond,
			path,
		});
		if (uniformScaleMotion && element.type !== "image") {
			fail(
				"UNSUPPORTED_TIMELINE",
				`${path}.animations`,
				"uniform scale motion is supported only for still images",
			);
		}
		const shapeMask = compileRenderSemanticVisualShapeMask({
			masks: element.masks,
			path,
		});
		const startFrame = frameForTicks(element.startTime, document.ticksPerSecond, `${path}.startTime`);
		const durationFrames = frameForTicks(element.duration, document.ticksPerSecond, `${path}.duration`, 1);
		if (startFrame !== expectedStartFrame) {
			fail("INVALID_TIMELINE", `${path}.startTime`, "visual clips must form one contiguous, non-overlapping sequence");
		}
		expectedStartFrame += durationFrames;
		const asset = requireAsset(assets, element.mediaId, `${path}.mediaId`);
		if (asset.mediaType !== element.type) {
			fail("ASSET_BINDING_INVALID", `${path}.mediaId`, `expects ${element.type}, received ${asset.mediaType}`);
		}
		let trim: RenderSemanticSourceTrim | null = null;
		const fill = shortVideoFillDescriptor(element, path);
		if (element.type === "image") {
			if (fill) {
				fail("INVALID_TIMELINE", `${path}.manju.shortVideoFill`, "is only valid on a video element");
			}
			if (element.trimStart !== 0 || element.trimEnd !== 0 || element.sourceDuration !== undefined) {
				fail("UNSUPPORTED_TIMELINE", path, "still images cannot carry source trim values");
			}
			for (const key of ["volume", "audioRole", "fadeInSeconds", "fadeOutSeconds"] as const) {
				if (element.params[key] !== undefined) {
					fail("UNSUPPORTED_TIMELINE", `${path}.params.${key}`, "cannot affect a still image");
				}
			}
		} else {
			let sourceElement = element;
			let fallbackAsset: NormalizedAssetBinding | null = null;
			if (fill) {
				if (opacityFade || uniformScaleMotion || shapeMask) {
					fail(
						"UNSUPPORTED_TIMELINE",
						opacityFade
							? `${path}.animations.opacity`
							: uniformScaleMotion
								? `${path}.animations`
								: `${path}.masks`,
						"compositor semantics cannot yet span a video plus its audited still-image hold",
					);
				}
				if (!fill.appliedByOpenCut || !fill.appliedPlanHash) {
					fail(
						"INVALID_TIMELINE",
						`${path}.manju.shortVideoFill`,
						"is pending the audited OpenCut atomic edit",
					);
				}
				if (fill.storySceneId !== element.params.storySceneId
					|| fill.storyShotId !== element.params.storyShotId) {
					fail(
						"INVALID_TIMELINE",
						`${path}.manju.shortVideoFill`,
						"must match the element Story scene and shot",
					);
				}
				if (fill.sourceRevisionId !== storyRevisionId
					|| element.params.sourceRevisionId !== storyRevisionId) {
					fail(
						"INVALID_TIMELINE",
						`${path}.manju.shortVideoFill.sourceRevisionId`,
						"does not match the pinned Story revision",
					);
				}
				if (element.trimStart !== 0 || element.trimEnd !== 0) {
					fail(
						"UNSUPPORTED_TIMELINE",
						path,
						"short-video image hold requires an untrimmed managed video",
					);
				}
				if (element.duration !== fill.targetDurationTicks) {
					fail(
						"INVALID_TIMELINE",
						`${path}.duration`,
						"short-video image hold has not been applied to its pinned target duration",
					);
				}
				if (element.sourceDuration !== fill.sourceDurationTicks) {
					fail(
						"INVALID_TIMELINE",
						`${path}.sourceDuration`,
						"does not match the explicit short-video source duration",
					);
				}
				const sourceDurationFrames = positiveInteger(
					asset.sourceDurationFrames,
					`${path}.asset.sourceDurationFrames`,
				);
				const pinnedSourceFrames = frameForTicks(
					fill.sourceDurationTicks,
					document.ticksPerSecond,
					`${path}.manju.shortVideoFill.sourceDurationTicks`,
					1,
				);
				if (pinnedSourceFrames !== sourceDurationFrames) {
					fail(
						"INVALID_TIMELINE",
						`${path}.manju.shortVideoFill.sourceDurationTicks`,
						"does not match the immutable video duration",
					);
				}
				fallbackAsset = requireAsset(
					assets,
					fill.fallbackAssetId,
					`${path}.manju.shortVideoFill.fallbackAssetId`,
				);
				if (fallbackAsset.mediaType !== "image") {
					fail(
						"ASSET_BINDING_INVALID",
						`${path}.manju.shortVideoFill.fallbackAssetId`,
						"must identify an immutable image",
					);
				}
				sourceElement = {
					...element,
					duration: fill.sourceDurationTicks,
					trimEnd: 0,
				};
			}
			trim = sourceTrim(sourceElement, asset, document.ticksPerSecond, path);
			const hasAudioParams = ["volume", "audioRole", "fadeInSeconds", "fadeOutSeconds"]
				.some((key) => element.params[key] !== undefined);
			if (!projectTimelineMediaParticipation(track, element).sourceAudio && hasAudioParams) {
				fail("UNSUPPORTED_TIMELINE", `${path}.params`, "source-audio mix values require enabled source audio");
			}
			if (projectTimelineMediaParticipation(track, element).sourceAudio) {
				audioWithoutDucking.push(audioClip(
					sourceElement,
					asset,
					`${element.id}:source-audio`,
					document.ticksPerSecond,
					path,
				));
			}
			if (fill && fallbackAsset) {
				const sourceFrames = trim.durationFrames;
				const fillFrames = durationFrames - sourceFrames;
				if (fillFrames < 1) {
					fail("INVALID_TIMELINE", `${path}.duration`, "does not leave a positive image-hold interval");
				}
				const fit = fitFromElement(element, path);
				return [{
					id: element.id,
					mediaType: "video",
					asset: assetPin(asset),
					startFrame,
					durationFrames: sourceFrames,
					endFrameExclusive: startFrame + sourceFrames,
					sourceTrim: trim,
					fit,
				}, {
					id: shortVideoFillClipId(element.id),
					mediaType: "image",
					asset: assetPin(fallbackAsset),
					startFrame: startFrame + sourceFrames,
					durationFrames: fillFrames,
					endFrameExclusive: startFrame + durationFrames,
					sourceTrim: null,
					fit,
				}];
			}
		}
		return [{
			id: element.id,
			mediaType: element.type,
			asset: assetPin(asset),
			startFrame,
			durationFrames,
			endFrameExclusive: startFrame + durationFrames,
			sourceTrim: trim,
			fit: fitFromElement(element, path),
			...(opacityFade ? { opacityFade } : {}),
			...(uniformScaleMotion ? { uniformScaleMotion } : {}),
			...(shapeMask ? { shapeMask } : {}),
		}];
	});
	if (visualClips.length > MAX_VISUAL_CLIPS) {
		fail("INVALID_TIMELINE", "$.timelineDocument.tracks", `expands to more than ${MAX_VISUAL_CLIPS} visual clips`);
	}
	const totalFrames = expectedStartFrame;
	if (totalFrames > MAX_TOTAL_FRAMES) {
		fail("INVALID_TIMELINE", "$.timelineDocument.tracks", "duration exceeds six hours");
	}

	for (const [trackIndex, track] of document.tracks.audio.entries()) {
		for (const [elementIndex, element] of track.elements.entries()) {
			if (!projectTimelineMediaParticipation(track, element).timelineAudio) continue;
			const path = `$.timelineDocument.tracks.audio[${trackIndex}].elements[${elementIndex}]`;
			if (element.type !== "audio" || element.sourceType !== "upload") {
				fail("UNSUPPORTED_TIMELINE", path, "only pinned upload audio is supported");
			}
			assertAllowedParams(element, AUDIO_PARAM_KEYS, path);
			const asset = requireAsset(assets, element.mediaId, `${path}.mediaId`);
			if (asset.mediaType !== "audio") {
				fail("ASSET_BINDING_INVALID", `${path}.mediaId`, `expects audio, received ${asset.mediaType}`);
			}
			const clip = audioClip(element, asset, element.id, document.ticksPerSecond, path);
			if (clip.startFrame >= totalFrames || clip.endFrameExclusive > totalFrames) {
				fail("INVALID_TIMELINE", path, "audio clip exceeds the visual duration");
			}
			audioWithoutDucking.push(clip);
		}
	}
	if (audioWithoutDucking.length > MAX_AUDIO_CLIPS) {
		fail("INVALID_TIMELINE", "$.timelineDocument.tracks.audio", `has more than ${MAX_AUDIO_CLIPS} audio clips`);
	}
	audioWithoutDucking.sort((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id));
	const dialogueWindows = mergedDialogueWindows(audioWithoutDucking);
	const audioClips: RenderSemanticAudioClip[] = audioWithoutDucking.map((clip) => ({
		...clip,
		duckingWindows: duckingWindowsForClip(clip, dialogueWindows),
	}));

	const subtitleCues: RenderSemanticSubtitleCue[] = [];
	for (const [trackIndex, track] of document.tracks.overlay.entries()) {
		if (track.type !== "text" || isTimelineTrackHidden(track)) continue;
		for (const [elementIndex, element] of track.elements.entries()) {
			if (isTimelineElementHidden(track, element)) continue;
			const path = `$.timelineDocument.tracks.overlay[${trackIndex}].elements[${elementIndex}]`;
			if (element.type !== "text") fail("INVALID_TIMELINE", `${path}.type`, "must be text");
			assertPlainComposition(element, path);
			assertAllowedParams(element, SUBTITLE_PARAM_KEYS, path);
			if (element.trimStart !== 0 || element.trimEnd !== 0 || element.sourceDuration !== undefined) {
				fail("UNSUPPORTED_TIMELINE", path, "subtitle source trimming is unsupported");
			}
			const startFrame = frameForTicks(element.startTime, document.ticksPerSecond, `${path}.startTime`);
			const durationFrames = frameForTicks(element.duration, document.ticksPerSecond, `${path}.duration`, 1);
			const endFrameExclusive = startFrame + durationFrames;
			if (startFrame >= totalFrames || endFrameExclusive > totalFrames) {
				fail("INVALID_TIMELINE", path, "subtitle cue exceeds the visual duration");
			}
			subtitleCues.push({
				id: element.id,
				startFrame,
				durationFrames,
				endFrameExclusive,
				text: subtitleText(element, path),
			});
		}
	}
	subtitleCues.sort((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id));
	for (let index = 1; index < subtitleCues.length; index += 1) {
		const previous = subtitleCues[index - 1]!;
		const current = subtitleCues[index]!;
		if (current.startFrame < previous.endFrameExclusive) {
			fail("UNSUPPORTED_TIMELINE", "$.timelineDocument.tracks.overlay", "overlapping subtitle cues are ambiguous");
		}
	}

	return deepFreeze({
		version: RENDER_SEMANTIC_PLAN_VERSION,
		timelineDocumentId,
		timelineRevisionId,
		storyRevisionId,
		upstreamCommit: document.upstreamCommit,
		ticksPerSecond: document.ticksPerSecond,
		frameRate: RENDER_SEMANTIC_FRAME_RATE,
		aspectRatio: input.aspectRatio,
		totalFrames,
		visualClips,
		audioClips,
		subtitleCues,
		audioMix: {
			dialogueDucking: {
				triggerRole: "dialogue",
				targetRole: "bgm",
				duckedLinearGain: RENDER_SEMANTIC_DIALOGUE_DUCKED_LINEAR_GAIN,
				attackSeconds: RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS,
				releaseSeconds: RENDER_SEMANTIC_DIALOGUE_DUCKING_SMOOTH_SECONDS,
				mergedDialogueWindows: dialogueWindows,
			},
		},
	}) as RenderSemanticPlan;
}

function roundedGain(value: number): number {
	const rounded = Number(value.toFixed(6));
	return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Evaluate the exact compositor opacity at an absolute output frame. Preview
 * and Canvas/WebCodecs use this helper; FFmpeg consumes the same two pinned
 * linear segments through its `fade` filter.
 */
export function renderSemanticVisualOpacityAtFrame(
	clip: RenderSemanticVisualClip,
	frame: number,
): number {
	if (!Number.isFinite(frame)) return 0;
	if (frame < clip.startFrame || frame >= clip.endFrameExclusive) return 0;
	const fade = clip.opacityFade;
	if (!fade) return 1;
	const localFrame = frame - clip.startFrame;
	let opacity = 1;
	if (fade.fadeIn) {
		const start = fade.fadeIn.startFrame;
		const end = start + fade.fadeIn.durationFrames;
		opacity = localFrame <= start
			? 0
			: localFrame >= end
				? 1
				: (localFrame - start) / fade.fadeIn.durationFrames;
	}
	if (fade.fadeOut) {
		const start = fade.fadeOut.startFrame;
		const end = start + fade.fadeOut.durationFrames;
		const fadeOutOpacity = localFrame <= start
			? 1
			: localFrame >= end
				? 0
				: 1 - (localFrame - start) / fade.fadeOut.durationFrames;
		opacity = Math.min(opacity, fadeOutOpacity);
	}
	return roundedGain(Math.max(0, Math.min(1, opacity)));
}

/**
 * Evaluate the exact centre-anchored uniform scale at an absolute output
 * frame. A neutral scale is returned outside the clip so callers can apply the
 * result without carrying a second participation sentinel.
 */
export function renderSemanticVisualScaleAtFrame(
	clip: RenderSemanticVisualClip,
	frame: number,
): number {
	if (!Number.isFinite(frame)) return 1;
	if (frame < clip.startFrame || frame >= clip.endFrameExclusive) return 1;
	const motion = clip.uniformScaleMotion;
	if (!motion) return 1;
	const localFrame = frame - clip.startFrame;
	const endFrame = motion.startFrame + motion.durationFrames;
	if (localFrame <= motion.startFrame) return motion.fromScale;
	if (localFrame >= endFrame) return motion.toScale;
	const progress = (localFrame - motion.startFrame) / motion.durationFrames;
	return roundedGain(
		motion.fromScale + (motion.toScale - motion.fromScale) * progress,
	);
}

function duckingGainAtFrame(clip: RenderSemanticAudioClip, frame: number): number {
	const seconds = frame / RENDER_SEMANTIC_FRAME_RATE;
	let gain = 1;
	for (const window of clip.duckingWindows) {
		const dialogueStart = window.startFrame / RENDER_SEMANTIC_FRAME_RATE;
		const dialogueEnd = window.endFrameExclusive / RENDER_SEMANTIC_FRAME_RATE;
		const attackStart = dialogueStart - window.attackSeconds;
		const releaseEnd = dialogueEnd + window.releaseSeconds;
		if (seconds < attackStart || seconds >= releaseEnd) continue;
		if (seconds < dialogueStart) {
			gain *= 1 - (1 - window.duckedLinearGain) * (
				(seconds - attackStart) / window.attackSeconds
			);
		} else if (seconds < dialogueEnd) {
			gain *= window.duckedLinearGain;
		} else {
			gain *= window.duckedLinearGain + (1 - window.duckedLinearGain) * (
				(seconds - dialogueEnd) / window.releaseSeconds
			);
		}
	}
	return gain;
}

function effectiveGainAtFrame(clip: RenderSemanticAudioClip, frame: number): number {
	const relativeSeconds = (frame - clip.startFrame) / RENDER_SEMANTIC_FRAME_RATE;
	const durationSeconds = clip.durationFrames / RENDER_SEMANTIC_FRAME_RATE;
	let fadeGain = 1;
	if (clip.fadeInSeconds > 0 && relativeSeconds < clip.fadeInSeconds) {
		fadeGain *= Math.max(0, relativeSeconds / clip.fadeInSeconds);
	}
	const fadeOutStart = durationSeconds - clip.fadeOutSeconds;
	if (clip.fadeOutSeconds > 0 && relativeSeconds >= fadeOutStart) {
		fadeGain *= Math.max(0, (durationSeconds - relativeSeconds) / clip.fadeOutSeconds);
	}
	return clip.linearGain * fadeGain * duckingGainAtFrame(clip, frame);
}

function addTransitionFrames(
	frames: Set<number>,
	transition: number,
	totalFrames: number,
): void {
	for (const anchor of new Set([Math.floor(transition), Math.ceil(transition)])) {
		for (const candidate of [anchor - 1, anchor, anchor + 1]) {
			if (candidate >= 0 && candidate < totalFrames) frames.add(candidate);
		}
	}
}

/**
 * Canonical semantic samples immediately before/at/after every clip, cue,
 * fade, and ducking transition. This is intentionally a JSON string so a
 * preview compositor and a server renderer can compare one stable golden.
 */
export function renderSemanticPlanBoundarySignature(plan: RenderSemanticPlan): string {
	const frames = new Set<number>();
	addTransitionFrames(frames, 0, plan.totalFrames);
	addTransitionFrames(frames, plan.totalFrames, plan.totalFrames);
	for (const clip of plan.visualClips) {
		addTransitionFrames(frames, clip.startFrame, plan.totalFrames);
		addTransitionFrames(frames, clip.endFrameExclusive, plan.totalFrames);
		if (clip.opacityFade?.fadeIn) {
			addTransitionFrames(
				frames,
				clip.startFrame + clip.opacityFade.fadeIn.startFrame,
				plan.totalFrames,
			);
			addTransitionFrames(
				frames,
				clip.startFrame + clip.opacityFade.fadeIn.startFrame
					+ clip.opacityFade.fadeIn.durationFrames,
				plan.totalFrames,
			);
		}
		if (clip.opacityFade?.fadeOut) {
			addTransitionFrames(
				frames,
				clip.startFrame + clip.opacityFade.fadeOut.startFrame,
				plan.totalFrames,
			);
			addTransitionFrames(
				frames,
				clip.startFrame + clip.opacityFade.fadeOut.startFrame
					+ clip.opacityFade.fadeOut.durationFrames,
				plan.totalFrames,
			);
		}
		if (clip.uniformScaleMotion) {
			const start = clip.startFrame + clip.uniformScaleMotion.startFrame;
			const end = start + clip.uniformScaleMotion.durationFrames;
			addTransitionFrames(frames, start, plan.totalFrames);
			addTransitionFrames(frames, start + clip.uniformScaleMotion.durationFrames / 2, plan.totalFrames);
			addTransitionFrames(frames, end, plan.totalFrames);
		}
	}
	for (const clip of plan.audioClips) {
		addTransitionFrames(frames, clip.startFrame, plan.totalFrames);
		addTransitionFrames(frames, clip.endFrameExclusive, plan.totalFrames);
		addTransitionFrames(
			frames,
			clip.startFrame + clip.fadeInSeconds * plan.frameRate,
			plan.totalFrames,
		);
		addTransitionFrames(
			frames,
			clip.endFrameExclusive - clip.fadeOutSeconds * plan.frameRate,
			plan.totalFrames,
		);
		for (const window of clip.duckingWindows) {
			addTransitionFrames(
				frames,
				window.startFrame - window.attackSeconds * plan.frameRate,
				plan.totalFrames,
			);
			addTransitionFrames(frames, window.startFrame, plan.totalFrames);
			addTransitionFrames(frames, window.endFrameExclusive, plan.totalFrames);
			addTransitionFrames(
				frames,
				window.endFrameExclusive + window.releaseSeconds * plan.frameRate,
				plan.totalFrames,
			);
		}
	}
	for (const cue of plan.subtitleCues) {
		addTransitionFrames(frames, cue.startFrame, plan.totalFrames);
		addTransitionFrames(frames, cue.endFrameExclusive, plan.totalFrames);
	}

	const samples = [...frames].sort((left, right) => left - right).map((frame) => ({
		frame,
		visual: plan.visualClips
			.filter((clip) => clip.startFrame <= frame && frame < clip.endFrameExclusive)
			.map((clip) => ({
				id: clip.id,
				asset: `${clip.asset.assetId}@${clip.asset.version}:${clip.asset.checksum}`,
				fit: clip.fit,
				...(clip.shapeMask ? { shapeMask: clip.shapeMask } : {}),
				...(clip.opacityFade
					? { opacity: renderSemanticVisualOpacityAtFrame(clip, frame) }
					: {}),
				...(clip.uniformScaleMotion
					? { scale: renderSemanticVisualScaleAtFrame(clip, frame) }
					: {}),
				sourceFrame: clip.sourceTrim === null
					? null
					: clip.sourceTrim.startFrame + frame - clip.startFrame,
			})),
		audio: plan.audioClips
			.filter((clip) => clip.startFrame <= frame && frame < clip.endFrameExclusive)
			.map((clip) => {
				const duckingGain = duckingGainAtFrame(clip, frame);
				return {
					id: clip.id,
					asset: `${clip.asset.assetId}@${clip.asset.version}:${clip.asset.checksum}`,
					role: clip.role,
					sourceFrame: clip.sourceTrim.startFrame + frame - clip.startFrame,
					effectiveLinearGain: roundedGain(effectiveGainAtFrame(clip, frame)),
					ducked: duckingGain < 1 - 1e-9,
				};
			}),
		subtitles: plan.subtitleCues
			.filter((cue) => cue.startFrame <= frame && frame < cue.endFrameExclusive)
			.map((cue) => ({ id: cue.id, text: cue.text })),
	}));
	return JSON.stringify(samples);
}
