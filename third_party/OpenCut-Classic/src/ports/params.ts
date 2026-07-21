import { formatHex, formatHex8 } from "culori";
import { clamp } from "../utils/math";

/** Narrow compatibility surface used by the extracted animation pipeline. */
export type ParamValue = number | string | boolean;
export type ParamValues = Record<string, ParamValue>;

export type ChannelValueKind = "scalar" | "discrete";

export interface ChannelComponentDefinition<TKey extends string = string> {
	key: TKey;
	valueKind: ChannelValueKind;
	defaultInterpolation: "linear" | "hold";
}

export interface LeafChannelLayout<TValue extends ParamValue = ParamValue> {
	kind: "leaf";
	component: ChannelComponentDefinition<"value">;
	easingMode: "independent";
	decompose: (value: TValue) => { value: TValue };
	compose: (components: { value?: TValue }) => TValue | null;
}

export interface LinearRgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

function linearToSrgb({ value }: { value: number }): number {
	const clamped = clamp({ value, min: 0, max: 1 });
	return clamped <= 0.0031308
		? clamped * 12.92
		: 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/** Exact runtime subset of OpenCut's params formatter used by keyframe query. */
export function formatLinearRgba({
	color,
}: {
	color: LinearRgba;
}): string {
	const rgb: {
		mode: "rgb";
		r: number;
		g: number;
		b: number;
		alpha: number;
	} = {
		mode: "rgb",
		r: linearToSrgb({ value: color.r }),
		g: linearToSrgb({ value: color.g }),
		b: linearToSrgb({ value: color.b }),
		alpha: clamp({ value: color.a, min: 0, max: 1 }),
	};
	return rgb.alpha < 1 ? formatHex8(rgb) : formatHex(rgb);
}

export interface CompositeChannelLayout<
	TValue extends ParamValue = ParamValue,
	TComponents extends object = Record<string, ParamValue>,
> {
	kind: "composite";
	components: Array<ChannelComponentDefinition<keyof TComponents & string>>;
	easingMode: "independent" | "shared";
	decompose: (value: TValue) => TComponents | null;
	compose: (components: Partial<TComponents>) => TValue | null;
}

export type ParamChannelLayout =
	| LeafChannelLayout<number>
	| LeafChannelLayout<boolean>
	| LeafChannelLayout<string>
	| CompositeChannelLayout<string, LinearRgba>;
