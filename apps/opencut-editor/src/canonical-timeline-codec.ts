import {
	PINNED_OPEN_CUT_CLASSIC_COMMIT,
	PINNED_OPEN_CUT_TICKS_PER_SECOND,
} from "./opencut-pinned-provenance.js";

const OPEN_CUT_CLASSIC_COMMIT = PINNED_OPEN_CUT_CLASSIC_COMMIT;
const OPEN_CUT_TICKS_PER_SECOND = PINNED_OPEN_CUT_TICKS_PER_SECOND;

/**
 * SHA-256 of apps/web/src/timeline/types.ts at OPEN_CUT_CLASSIC_COMMIT.
 *
 * The wire codec below mirrors that pinned discriminated union while keeping
 * browser-only values (notably AudioBuffer and Date) outside the persisted
 * timeline document.
 */
export const OPEN_CUT_TIMELINE_TYPES_UPSTREAM_SHA256 =
	"9ed9fbd54de1a9c7b27a98f833db712ee32dd0106c73a87be5ed466def8958ac";

export const CANONICAL_TIMELINE_DOCUMENT_VERSION = 2 as const;
export const CANONICAL_TIMELINE_SCHEMA_VERSION = 2 as const;

export type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
	| CanonicalJsonPrimitive
	| CanonicalJsonValue[]
	| { [key: string]: CanonicalJsonValue };
export type CanonicalJsonObject = { [key: string]: CanonicalJsonValue };

export type CanonicalParamValue = string | number | boolean;
export type CanonicalParamValues = Record<string, CanonicalParamValue>;

export interface CanonicalRetimeConfig {
	rate: number;
	maintainPitch?: boolean;
}

export interface CanonicalBaseTimelineElement {
	id: string;
	name: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	sourceDuration?: number;
	/**
	 * Exact pinned OpenCut ParamValues (flat primitives only). Existing Manju
	 * story-association keys remain a compatibility extension here; structured
	 * adapter state belongs in `manju`, and params.assetId is forbidden in v2.
	 */
	params: CanonicalParamValues;
	animations?: CanonicalJsonObject;
	retime?: CanonicalRetimeConfig;
	hidden?: boolean;
	effects?: CanonicalJsonObject[];
	/** Namespaced Manju metadata; never a substitute for union-required fields. */
	manju?: CanonicalJsonObject;
}

export interface CanonicalVideoElement extends CanonicalBaseTimelineElement {
	type: "video";
	mediaId: string;
	isSourceAudioEnabled?: boolean;
	masks?: CanonicalJsonObject[];
}

export interface CanonicalImageElement extends CanonicalBaseTimelineElement {
	type: "image";
	mediaId: string;
	masks?: CanonicalJsonObject[];
}

export interface CanonicalUploadAudioElement
	extends CanonicalBaseTimelineElement {
	type: "audio";
	sourceType: "upload";
	mediaId: string;
}

export interface CanonicalLibraryAudioElement
	extends CanonicalBaseTimelineElement {
	type: "audio";
	sourceType: "library";
	sourceUrl: string;
}

export type CanonicalAudioElement =
	| CanonicalUploadAudioElement
	| CanonicalLibraryAudioElement;

export interface CanonicalTextElement extends CanonicalBaseTimelineElement {
	type: "text";
}

export interface CanonicalStickerElement extends CanonicalBaseTimelineElement {
	type: "sticker";
	stickerId: string;
	intrinsicWidth?: number;
	intrinsicHeight?: number;
}

export interface CanonicalGraphicElement extends CanonicalBaseTimelineElement {
	type: "graphic";
	definitionId: string;
	masks?: CanonicalJsonObject[];
}

export interface CanonicalEffectElement extends CanonicalBaseTimelineElement {
	type: "effect";
	effectType: string;
}

export type CanonicalTimelineElement =
	| CanonicalAudioElement
	| CanonicalVideoElement
	| CanonicalImageElement
	| CanonicalTextElement
	| CanonicalStickerElement
	| CanonicalGraphicElement
	| CanonicalEffectElement;

interface CanonicalTrackBase {
	id: string;
	name: string;
	elements: CanonicalTimelineElement[];
}

export interface CanonicalVideoTrack extends CanonicalTrackBase {
	type: "video";
	hidden: boolean;
	muted: boolean;
}

export interface CanonicalTextTrack extends CanonicalTrackBase {
	type: "text";
	hidden: boolean;
}

export interface CanonicalAudioTrack extends CanonicalTrackBase {
	type: "audio";
	muted: boolean;
}

export interface CanonicalGraphicTrack extends CanonicalTrackBase {
	type: "graphic";
	hidden: boolean;
}

export interface CanonicalEffectTrack extends CanonicalTrackBase {
	type: "effect";
	hidden: boolean;
}

export type CanonicalOverlayTrack =
	| CanonicalVideoTrack
	| CanonicalTextTrack
	| CanonicalGraphicTrack
	| CanonicalEffectTrack;

export interface CanonicalSceneTracks {
	overlay: CanonicalOverlayTrack[];
	main: CanonicalVideoTrack;
	audio: CanonicalAudioTrack[];
}

export interface CanonicalTimelineDocument {
	version: typeof CANONICAL_TIMELINE_DOCUMENT_VERSION;
	editor: "OpenCut-Classic";
	upstreamCommit: typeof OPEN_CUT_CLASSIC_COMMIT;
	ticksPerSecond: typeof OPEN_CUT_TICKS_PER_SECOND;
	frameRate: {
		numerator: number;
		denominator: number;
	};
	tracks: CanonicalSceneTracks;
	manju?: CanonicalJsonObject;
}

export interface CanonicalTimelineParseResult {
	document: CanonicalTimelineDocument;
	migratedFromVersion: 1 | null;
}

export class OpenCutTimelineCodecError extends Error {
	constructor(
		message: string,
		readonly path: string,
		options?: ErrorOptions,
	) {
		super(`${path}: ${message}`, options);
		this.name = "OpenCutTimelineCodecError";
	}
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ELEMENT_TYPES = new Set([
	"audio",
	"text",
	"sticker",
	"graphic",
	"effect",
	"video",
	"image",
]);

function codecError(path: string, message: string): never {
	throw new OpenCutTimelineCodecError(message, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function cloneJson(
	value: unknown,
	path = "$",
	depth = 0,
	state: { nodes: number; seen: Set<unknown> } = {
		nodes: 0,
		seen: new Set(),
	},
): CanonicalJsonValue {
	state.nodes += 1;
	if (state.nodes > 100_000) codecError(path, "document has too many JSON nodes");
	if (depth > 64) codecError(path, "document is nested too deeply");
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) codecError(path, "number must be finite");
		return value;
	}
	if (typeof value !== "object") codecError(path, "value is not JSON serializable");
	if (state.seen.has(value)) codecError(path, "document contains a cycle");
	state.seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item, index) =>
				cloneJson(item, `${path}[${index}]`, depth + 1, state),
			);
		}
		if (!isRecord(value)) codecError(path, "value must be a plain JSON object");
		const result: CanonicalJsonObject = {};
		for (const [key, item] of Object.entries(value)) {
			if (FORBIDDEN_KEYS.has(key)) codecError(`${path}.${key}`, "unsafe key");
			result[key] = cloneJson(item, `${path}.${key}`, depth + 1, state);
		}
		return result;
	} finally {
		state.seen.delete(value);
	}
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) codecError(path, "must be an object");
	return value;
}

function requireArray(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) codecError(path, "must be an array");
	return value;
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) {
		codecError(path, "must be a non-empty string");
	}
	return value;
}

function requireBoolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") codecError(path, "must be a boolean");
	return value;
}

function requireInteger(
	value: unknown,
	path: string,
	minimum = 0,
): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		codecError(path, `must be a safe integer >= ${minimum}`);
	}
	return value as number;
}

function optionalInteger(value: unknown, path: string): number | undefined {
	return value === undefined ? undefined : requireInteger(value, path);
}

function validateParams(value: unknown, path: string): void {
	const params = requireRecord(value, path);
	for (const [key, item] of Object.entries(params)) {
		if (
			typeof item !== "string" &&
			typeof item !== "boolean" &&
			!(typeof item === "number" && Number.isFinite(item))
		) {
			codecError(`${path}.${key}`, "OpenCut ParamValues must be string, number, or boolean");
		}
	}
}

function validateObjectArray(value: unknown, path: string): void {
	requireArray(value, path).forEach((item, index) => {
		requireRecord(item, `${path}[${index}]`);
	});
}

function validateBaseElement(value: Record<string, unknown>, path: string): void {
	requireString(value.id, `${path}.id`);
	requireString(value.name, `${path}.name`);
	requireInteger(value.startTime, `${path}.startTime`);
	requireInteger(value.duration, `${path}.duration`, 1);
	requireInteger(value.trimStart, `${path}.trimStart`);
	requireInteger(value.trimEnd, `${path}.trimEnd`);
	optionalInteger(value.sourceDuration, `${path}.sourceDuration`);
	validateParams(value.params, `${path}.params`);
	if (value.hidden !== undefined) requireBoolean(value.hidden, `${path}.hidden`);
	if (value.animations !== undefined) requireRecord(value.animations, `${path}.animations`);
	if (value.effects !== undefined) validateObjectArray(value.effects, `${path}.effects`);
	if (value.masks !== undefined) validateObjectArray(value.masks, `${path}.masks`);
	if (value.manju !== undefined) requireRecord(value.manju, `${path}.manju`);
	if (value.retime !== undefined) {
		const retime = requireRecord(value.retime, `${path}.retime`);
		if (
			typeof retime.rate !== "number" ||
			!Number.isFinite(retime.rate) ||
			retime.rate <= 0
		) {
			codecError(`${path}.retime.rate`, "must be a positive finite number");
		}
		if (retime.maintainPitch !== undefined) {
			requireBoolean(retime.maintainPitch, `${path}.retime.maintainPitch`);
		}
	}
}

function validateElement(value: unknown, path: string): CanonicalTimelineElement {
	const element = requireRecord(value, path);
	validateBaseElement(element, path);
	const params = requireRecord(element.params, `${path}.params`);
	if (Object.prototype.hasOwnProperty.call(params, "assetId")) {
		codecError(
			`${path}.params.assetId`,
			"legacy asset alias is forbidden in canonical v2; use the union field",
		);
	}
	if (typeof element.type !== "string" || !ELEMENT_TYPES.has(element.type)) {
		codecError(`${path}.type`, "is not a pinned OpenCut element type");
	}
	switch (element.type) {
		case "image":
			requireString(element.mediaId, `${path}.mediaId`);
			break;
		case "video":
			requireString(element.mediaId, `${path}.mediaId`);
			if (element.isSourceAudioEnabled !== undefined) {
				requireBoolean(
					element.isSourceAudioEnabled,
					`${path}.isSourceAudioEnabled`,
				);
			}
			break;
		case "audio":
			if (element.sourceType === "upload") {
				requireString(element.mediaId, `${path}.mediaId`);
				if (element.sourceUrl !== undefined) {
					codecError(
						`${path}.sourceUrl`,
						"must be absent for upload audio",
					);
				}
			} else if (element.sourceType === "library") {
				requireString(element.sourceUrl, `${path}.sourceUrl`);
				if (element.mediaId !== undefined) {
					codecError(
						`${path}.mediaId`,
						"must be absent for library audio",
					);
				}
			} else {
				codecError(`${path}.sourceType`, "must be upload or library");
			}
			break;
		case "sticker":
			requireString(element.stickerId, `${path}.stickerId`);
			optionalInteger(element.intrinsicWidth, `${path}.intrinsicWidth`);
			optionalInteger(element.intrinsicHeight, `${path}.intrinsicHeight`);
			break;
		case "graphic":
			requireString(element.definitionId, `${path}.definitionId`);
			break;
		case "effect":
			requireString(element.effectType, `${path}.effectType`);
			break;
		case "text":
			break;
	}
	return element as unknown as CanonicalTimelineElement;
}

function validateTrack(
	value: unknown,
	path: string,
	allowedTypes: readonly string[],
): CanonicalOverlayTrack | CanonicalVideoTrack | CanonicalAudioTrack {
	const track = requireRecord(value, path);
	requireString(track.id, `${path}.id`);
	requireString(track.name, `${path}.name`);
	if (typeof track.type !== "string" || !allowedTypes.includes(track.type)) {
		codecError(`${path}.type`, "is not compatible with this track group");
	}
	if (track.type === "audio") {
		requireBoolean(track.muted, `${path}.muted`);
	} else {
		requireBoolean(track.hidden, `${path}.hidden`);
		if (track.type === "video") requireBoolean(track.muted, `${path}.muted`);
	}
	const elements = requireArray(track.elements, `${path}.elements`).map((element, index) =>
		validateElement(element, `${path}.elements[${index}]`),
	);
	const compatible = elements.every((element) => {
		switch (track.type) {
			case "video":
				return element.type === "image" || element.type === "video";
			case "audio":
				return element.type === "audio";
			case "text":
				return element.type === "text";
			case "graphic":
				return element.type === "sticker" || element.type === "graphic";
			case "effect":
				return element.type === "effect";
			default:
				return false;
		}
	});
	if (!compatible) codecError(`${path}.elements`, "contains an incompatible element type");
	return track as unknown as
		| CanonicalOverlayTrack
		| CanonicalVideoTrack
		| CanonicalAudioTrack;
}

function validateV2Document(value: CanonicalJsonObject): CanonicalTimelineDocument {
	if (value.version !== CANONICAL_TIMELINE_DOCUMENT_VERSION) {
		codecError("$.version", `must be ${CANONICAL_TIMELINE_DOCUMENT_VERSION}`);
	}
	if (value.editor !== "OpenCut-Classic") {
		codecError("$.editor", "must identify OpenCut-Classic");
	}
	if (value.upstreamCommit !== OPEN_CUT_CLASSIC_COMMIT) {
		codecError("$.upstreamCommit", "does not match the pinned OpenCut commit");
	}
	if (value.ticksPerSecond !== OPEN_CUT_TICKS_PER_SECOND) {
		codecError("$.ticksPerSecond", "does not match OpenCut MediaTime");
	}
	const frameRate = requireRecord(value.frameRate, "$.frameRate");
	requireInteger(frameRate.numerator, "$.frameRate.numerator", 1);
	requireInteger(frameRate.denominator, "$.frameRate.denominator", 1);
	const tracks = requireRecord(value.tracks, "$.tracks");
	const overlay = requireArray(tracks.overlay, "$.tracks.overlay").map((track, index) =>
		validateTrack(track, `$.tracks.overlay[${index}]`, [
			"video",
			"text",
			"graphic",
			"effect",
		]),
	);
	validateTrack(tracks.main, "$.tracks.main", ["video"]);
	const audio = requireArray(tracks.audio, "$.tracks.audio").map((track, index) =>
		validateTrack(track, `$.tracks.audio[${index}]`, ["audio"]),
	);
	if (value.manju !== undefined) requireRecord(value.manju, "$.manju");

	const trackIds = new Set<string>();
	const elementIds = new Set<string>();
	for (const [index, track] of [...overlay, tracks.main, ...audio].entries()) {
		const typedTrack = track as unknown as {
			id: string;
			elements: Array<{ id: string }>;
		};
		if (trackIds.has(typedTrack.id)) {
			codecError(`$.tracks[*:${index}].id`, `duplicate track id ${typedTrack.id}`);
		}
		trackIds.add(typedTrack.id);
		for (const [elementIndex, element] of typedTrack.elements.entries()) {
			if (elementIds.has(element.id)) {
				codecError(
					`$.tracks[*:${index}].elements[${elementIndex}].id`,
					`duplicate element id ${element.id}`,
				);
			}
			elementIds.add(element.id);
		}
	}
	return value as unknown as CanonicalTimelineDocument;
}

function migrateParams(
	rawParams: unknown,
	path: string,
): {
	params: CanonicalParamValues;
	legacyAssetId: string | null;
	legacyParams: CanonicalJsonObject | null;
} {
	if (rawParams === undefined) {
		return { params: {}, legacyAssetId: null, legacyParams: null };
	}
	const source = requireRecord(rawParams, path);
	const params: CanonicalParamValues = {};
	const legacyParams: CanonicalJsonObject = {};
	let legacyAssetId: string | null = null;
	for (const [key, item] of Object.entries(source)) {
		if (key === "assetId") {
			legacyAssetId =
				typeof item === "string" && item.length > 0 ? item : null;
			continue;
		}
		if (
			typeof item === "string" ||
			typeof item === "boolean" ||
			(typeof item === "number" && Number.isFinite(item))
		) {
			params[key] = item;
		} else {
			legacyParams[key] = item as CanonicalJsonValue;
		}
	}
	return {
		params,
		legacyAssetId,
		legacyParams: Object.keys(legacyParams).length ? legacyParams : null,
	};
}

interface LegacyStoryReference {
	sceneId: string;
	shotId: string;
}

/**
 * Older Manju editor snapshots used the one-based UI shot number in
 * `params.shotId` and kept the durable Story identifiers in the ordered
 * `manjuTimeline.storyShots` manifest.  Only trust that mapping for the
 * adapter version that wrote this shape; malformed or out-of-range values are
 * deliberately left unresolved so the existing fail-closed validation fires.
 */
function legacyStoryReferences(
	document: CanonicalJsonObject,
): LegacyStoryReference[] | null {
	if (!isRecord(document.manjuTimeline)) return null;
	const integration = document.manjuTimeline;
	if (integration.adapterVersion !== 1 || !Array.isArray(integration.storyShots)) {
		return null;
	}
	const references: LegacyStoryReference[] = [];
	for (const item of integration.storyShots) {
		if (
			!isRecord(item) ||
			typeof item.sceneId !== "string" ||
			item.sceneId.length === 0 ||
			typeof item.shotId !== "string" ||
			item.shotId.length === 0
		) {
			return null;
		}
		references.push({ sceneId: item.sceneId, shotId: item.shotId });
	}
	return references.length > 0 ? references : null;
}

function restoreLegacyStoryAssociation(
	element: Record<string, unknown>,
	references: readonly LegacyStoryReference[] | null,
): Record<string, unknown> {
	if (
		!references ||
		(element.type !== "image" && element.type !== "video") ||
		!isRecord(element.params)
	) {
		return element;
	}
	const params = element.params;
	if (typeof params.storyShotId === "string" && params.storyShotId.length > 0) {
		return element;
	}
	const ordinal =
		typeof params.shotId === "number"
			? params.shotId
			: typeof params.shotId === "string" && /^[1-9]\d*$/.test(params.shotId)
				? Number(params.shotId)
				: Number.NaN;
	if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > references.length) {
		return element;
	}
	const reference = references[ordinal - 1];
	return {
		...element,
		params: {
			...params,
			storyShotId: reference.shotId,
			storySceneId: reference.sceneId,
		},
	};
}

function pendingMediaId(
	element: Record<string, unknown>,
	id: string,
	kind: "visual" | "audio",
): string {
	const params = isRecord(element.params) ? element.params : {};
	const hasStoryAssociation =
		typeof params.storyShotId === "string" && params.storyShotId.length > 0;
	const hasDialogueAssociation =
		(typeof params.dialogueLineId === "string" && params.dialogueLineId.length > 0) ||
		(typeof params.storyDialogueId === "string" && params.storyDialogueId.length > 0);
	if (
		(kind === "visual" && !hasStoryAssociation) ||
		(kind === "audio" && !hasDialogueAssociation)
	) {
		codecError(
			`$.tracks.*.elements[${id}].mediaId`,
			`legacy ${kind} element has neither mediaId nor params.assetId`,
		);
	}
	return `manju:pending:${encodeURIComponent(id)}`;
}

function mergeLegacyManju(
	element: Record<string, unknown>,
	legacyParams: CanonicalJsonObject | null,
	pending: boolean,
): CanonicalJsonObject | undefined {
	const existing = isRecord(element.manju)
		? (element.manju as CanonicalJsonObject)
		: undefined;
	if (!legacyParams && !pending) return existing;
	return {
		...(existing ?? {}),
		...(legacyParams ? { legacyParams } : {}),
		...(pending ? { mediaBindingState: "unresolved" } : {}),
	};
}

function migrateElement(
	value: unknown,
	path: string,
	references: readonly LegacyStoryReference[] | null,
): CanonicalJsonObject {
	const element = restoreLegacyStoryAssociation(
		requireRecord(value, path),
		references,
	);
	const id = requireString(element.id, `${path}.id`);
	if (typeof element.type !== "string" || !ELEMENT_TYPES.has(element.type)) {
		codecError(`${path}.type`, "is not a pinned OpenCut element type");
	}
	const { params, legacyAssetId, legacyParams } = migrateParams(
		element.params,
		`${path}.params`,
	);
	const migrated: CanonicalJsonObject = {
		...(element as CanonicalJsonObject),
		id,
		name: typeof element.name === "string" && element.name.length
			? element.name
			: id,
		startTime: requireInteger(element.startTime, `${path}.startTime`),
		duration: requireInteger(element.duration, `${path}.duration`, 1),
		trimStart: element.trimStart === undefined
			? 0
			: requireInteger(element.trimStart, `${path}.trimStart`),
		trimEnd: element.trimEnd === undefined
			? 0
			: requireInteger(element.trimEnd, `${path}.trimEnd`),
		params,
	};
	let pending = false;
	switch (element.type) {
		case "image":
		case "video": {
			const mediaId =
				typeof element.mediaId === "string" && element.mediaId.length
					? element.mediaId
					: legacyAssetId;
			pending = !mediaId;
			migrated.mediaId = mediaId ?? pendingMediaId(element, id, "visual");
			break;
		}
		case "audio": {
			const sourceType = element.sourceType === "library" ? "library" : "upload";
			migrated.sourceType = sourceType;
			if (sourceType === "library") {
				migrated.sourceUrl = requireString(element.sourceUrl, `${path}.sourceUrl`);
				delete migrated.mediaId;
			} else {
				const mediaId =
					typeof element.mediaId === "string" && element.mediaId.length
						? element.mediaId
						: legacyAssetId;
				pending = !mediaId;
				migrated.mediaId = mediaId ?? pendingMediaId(element, id, "audio");
				delete migrated.sourceUrl;
			}
			break;
		}
		case "sticker":
			migrated.stickerId = requireString(
				typeof element.stickerId === "string"
					? element.stickerId
					: params.stickerId,
				`${path}.stickerId`,
			);
			break;
		case "graphic":
			migrated.definitionId = requireString(
				typeof element.definitionId === "string"
					? element.definitionId
					: params.definitionId,
				`${path}.definitionId`,
			);
			break;
		case "effect":
			migrated.effectType = requireString(
				typeof element.effectType === "string"
					? element.effectType
					: params.effectType,
				`${path}.effectType`,
			);
			break;
		case "text":
			break;
	}
	delete (migrated.params as CanonicalJsonObject).assetId;
	const manju = mergeLegacyManju(element, legacyParams, pending);
	if (manju) migrated.manju = manju;
	return migrated;
}

function migrateTrack(
	value: unknown,
	path: string,
	allowedTypes: readonly string[],
	references: readonly LegacyStoryReference[] | null,
): CanonicalJsonObject {
	const track = requireRecord(value, path);
	const id = requireString(track.id, `${path}.id`);
	if (typeof track.type !== "string" || !allowedTypes.includes(track.type)) {
		codecError(`${path}.type`, "is not compatible with this track group");
	}
	const migrated: CanonicalJsonObject = {
		...(track as CanonicalJsonObject),
		id,
		name: typeof track.name === "string" && track.name.length ? track.name : id,
		elements: requireArray(track.elements, `${path}.elements`).map((element, index) =>
			migrateElement(element, `${path}.elements[${index}]`, references),
		),
	};
	if (track.type === "audio") {
		migrated.muted = typeof track.muted === "boolean" ? track.muted : false;
	} else {
		migrated.hidden = typeof track.hidden === "boolean" ? track.hidden : false;
		if (track.type === "video") {
			migrated.muted = typeof track.muted === "boolean" ? track.muted : false;
		}
	}
	return migrated;
}

function migrateV1Document(value: CanonicalJsonObject): CanonicalJsonObject {
	if (value.editor !== undefined && value.editor !== "OpenCut-Classic") {
		codecError("$.editor", "legacy document belongs to another editor");
	}
	if (
		value.upstreamCommit !== undefined &&
		value.upstreamCommit !== OPEN_CUT_CLASSIC_COMMIT
	) {
		codecError("$.upstreamCommit", "legacy document targets another OpenCut commit");
	}
	if (
		value.ticksPerSecond !== undefined &&
		value.ticksPerSecond !== OPEN_CUT_TICKS_PER_SECOND
	) {
		codecError("$.ticksPerSecond", "legacy document uses incompatible MediaTime ticks");
	}
	const tracks = requireRecord(value.tracks, "$.tracks");
	const storyReferences = legacyStoryReferences(value);
	const frameRate = value.frameRate === undefined
		? { numerator: 24, denominator: 1 }
		: requireRecord(value.frameRate, "$.frameRate");
	return {
		...value,
		version: CANONICAL_TIMELINE_DOCUMENT_VERSION,
		editor: "OpenCut-Classic",
		upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
		ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
		frameRate: {
			numerator: requireInteger(frameRate.numerator, "$.frameRate.numerator", 1),
			denominator: requireInteger(
				frameRate.denominator,
				"$.frameRate.denominator",
				1,
			),
		},
		tracks: {
			overlay: requireArray(tracks.overlay, "$.tracks.overlay").map((track, index) =>
				migrateTrack(track, `$.tracks.overlay[${index}]`, [
					"video",
					"text",
					"graphic",
					"effect",
				], storyReferences),
			),
			main: migrateTrack(
				tracks.main,
				"$.tracks.main",
				["video"],
				storyReferences,
			),
			audio: requireArray(tracks.audio, "$.tracks.audio").map((track, index) =>
				migrateTrack(
					track,
					`$.tracks.audio[${index}]`,
					["audio"],
					storyReferences,
				),
			),
		},
	};
}

/**
 * Parse a canonical v2 document or safely migrate the legacy v1 Manju shape.
 * Unknown JSON fields are retained byte-for-byte semantically; only legacy
 * fields that substituted for OpenCut union fields are normalized.
 */
export function canonicalizeOpenCutTimelineDocument(
	value: unknown,
): CanonicalTimelineParseResult {
	const cloned = cloneJson(value);
	if (!isRecord(cloned)) codecError("$", "timeline document must be an object");
	if (cloned.version === CANONICAL_TIMELINE_DOCUMENT_VERSION) {
		return {
			document: validateV2Document(cloned as CanonicalJsonObject),
			migratedFromVersion: null,
		};
	}
	if (cloned.version !== undefined && cloned.version !== 1) {
		codecError("$.version", "only legacy v1 and canonical v2 are supported");
	}
	const migrated = migrateV1Document(cloned as CanonicalJsonObject);
	return {
		document: validateV2Document(migrated),
		migratedFromVersion: 1,
	};
}

export function parseCanonicalTimelineDocument(
	value: unknown,
): CanonicalTimelineDocument {
	return canonicalizeOpenCutTimelineDocument(value).document;
}

export function serializeCanonicalTimelineDocument(value: unknown): string {
	return JSON.stringify(parseCanonicalTimelineDocument(value));
}

/** Build a canonical v2 document from an in-memory command-editor snapshot. */
export function canonicalTimelineDocumentFromTracks(
	tracks: unknown,
	base: Record<string, unknown> = {},
): CanonicalTimelineDocument {
	return parseCanonicalTimelineDocument({
		...base,
		// Route command-editor DTOs through the audited v1 migration so missing
		// legacy track flags and params.assetId are normalized in one place.
		version: 1,
		editor: "OpenCut-Classic",
		upstreamCommit: OPEN_CUT_CLASSIC_COMMIT,
		ticksPerSecond: OPEN_CUT_TICKS_PER_SECOND,
		frameRate: isRecord(base.frameRate)
			? base.frameRate
			: { numerator: 24, denominator: 1 },
		tracks,
	});
}
