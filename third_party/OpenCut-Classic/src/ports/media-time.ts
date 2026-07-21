/**
 * Compatibility port for the extracted OpenCut timeline algorithms.
 *
 * OpenCut represents time as integer ticks and defines 120,000 ticks per
 * second in rust/crates/time/src/media_time.rs. The full application obtains
 * these values through opencut-wasm; this extraction keeps the same invariant
 * without pulling the renderer/WASM runtime into the host application.
 */
export type MediaTime = number & { readonly __mediaTime: unique symbol };

/** Structural copy of opencut-wasm's exported frame-rate DTO. */
export interface FrameRate {
	numerator: number;
	denominator: number;
}

export const TICKS_PER_SECOND = 120_000;
export const ZERO_MEDIA_TIME = 0 as MediaTime;

export function mediaTime({ ticks }: { ticks: number }): MediaTime {
	if (!Number.isSafeInteger(ticks)) {
		throw new Error(`MediaTime must be a safe integer tick count, got ${ticks}`);
	}

	return ticks as MediaTime;
}

export function roundMediaTime({ time }: { time: number }): MediaTime {
	const roundedMagnitude = Math.round(Math.abs(time));
	if (roundedMagnitude === 0) {
		return ZERO_MEDIA_TIME;
	}
	return mediaTime({ ticks: time < 0 ? -roundedMagnitude : roundedMagnitude });
}

/**
 * Compatibility port for OpenCut's WASM `mediaTimeFromSeconds` helper.
 * Rust rounds fractional ticks away from zero before returning MediaTime.
 */
export function mediaTimeFromSeconds({
	seconds,
}: {
	seconds: number;
}): MediaTime {
	if (!Number.isFinite(seconds)) {
		throw new Error(
			`mediaTimeFromSeconds: expected a finite number, got ${seconds}`,
		);
	}
	return roundMediaTime({ time: seconds * TICKS_PER_SECOND });
}

export function addMediaTime({
	a,
	b,
}: {
	a: MediaTime;
	b: MediaTime;
}): MediaTime {
	return mediaTime({ ticks: a + b });
}

export function subMediaTime({
	a,
	b,
}: {
	a: MediaTime;
	b: MediaTime;
}): MediaTime {
	return mediaTime({ ticks: a - b });
}

export function maxMediaTime({
	a,
	b,
}: {
	a: MediaTime;
	b: MediaTime;
}): MediaTime {
	return a > b ? a : b;
}

export function minMediaTime({
	a,
	b,
}: {
	a: MediaTime;
	b: MediaTime;
}): MediaTime {
	return a < b ? a : b;
}

export function clampMediaTime({
	time,
	min,
	max,
}: {
	time: MediaTime;
	min: MediaTime;
	max: MediaTime;
}): MediaTime {
	if (time < min) return min;
	if (time > max) return max;
	return time;
}

function ticksPerFrame({ fps }: { fps: FrameRate }): number | null {
	if (
		!Number.isSafeInteger(fps.numerator) ||
		!Number.isSafeInteger(fps.denominator) ||
		fps.numerator <= 0 ||
		fps.denominator <= 0
	) {
		return null;
	}
	const tickNumerator = TICKS_PER_SECOND * fps.denominator;
	if (!Number.isSafeInteger(tickNumerator) || tickNumerator % fps.numerator !== 0) {
		return null;
	}
	return tickNumerator / fps.numerator;
}

/**
 * TypeScript port of OpenCut's Rust MediaTime::to_frame_round followed by
 * MediaTime::from_frame. Unsupported rates preserve the input like the
 * upstream WASM wrapper's `?? ticks` fallback.
 */
export function roundFrameTicks({
	ticks,
	fps,
}: {
	ticks: number;
	fps: FrameRate;
}): number {
	const frameTicks = ticksPerFrame({ fps });
	if (frameTicks === null || !Number.isSafeInteger(ticks)) {
		return ticks;
	}
	const floor = Math.floor(ticks / frameTicks);
	const remainder = ticks - floor * frameTicks;
	const frame = remainder * 2 >= frameTicks ? floor + 1 : floor;
	const result = frame * frameTicks;
	return Number.isSafeInteger(result) ? result : ticks;
}

export function roundFrameTime({
	time,
	fps,
}: {
	time: MediaTime;
	fps: FrameRate;
}): MediaTime {
	return mediaTime({ ticks: roundFrameTicks({ ticks: time, fps }) });
}

/**
 * Compatibility port for OpenCut's WASM `snappedSeekTime` helper. Supported
 * rates round to the nearest frame and clamp to the inclusive timeline
 * duration. For an unsupported rate, the upstream TypeScript wrapper falls
 * back to the input time unchanged.
 */
export function snapSeekMediaTime({
	time,
	duration,
	fps,
}: {
	time: MediaTime;
	duration: MediaTime;
	fps: FrameRate;
}): MediaTime {
	if (ticksPerFrame({ fps }) === null) {
		return time;
	}

	const snapped = roundFrameTime({ time, fps });
	return clampMediaTime({ time: snapped, min: ZERO_MEDIA_TIME, max: duration });
}
