/** Exact predicate subset from OpenCut's graphic/effect param path modules. */
export const GRAPHIC_PARAM_PATH_PREFIX = "params.";
export const EFFECT_PARAM_PATH_PREFIX = "effects.";
export const EFFECT_PARAM_PATH_SUFFIX = ".params.";

export function isGraphicParamPath(propertyPath: string): boolean {
	return propertyPath.startsWith(GRAPHIC_PARAM_PATH_PREFIX);
}

export function isEffectParamPath(propertyPath: string): boolean {
	return (
		propertyPath.startsWith(EFFECT_PARAM_PATH_PREFIX) &&
		propertyPath.includes(EFFECT_PARAM_PATH_SUFFIX)
	);
}
