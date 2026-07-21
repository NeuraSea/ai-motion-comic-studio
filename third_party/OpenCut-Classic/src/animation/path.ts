import type { AnimationPath, AnimationPropertyPath } from "./types";
import { ANIMATION_PROPERTY_PATHS } from "./types";
import {
	isEffectParamPath,
	isGraphicParamPath,
} from "../ports/animation-param-path";

const ANIMATION_PROPERTY_PATH_SET = new Set<string>(ANIMATION_PROPERTY_PATHS);

export function isAnimationPropertyPath(
	propertyPath: string,
): propertyPath is AnimationPropertyPath {
	return ANIMATION_PROPERTY_PATH_SET.has(propertyPath);
}

export function isAnimationPath(
	propertyPath: string,
): propertyPath is AnimationPath {
	return (
		isAnimationPropertyPath(propertyPath) ||
		isGraphicParamPath(propertyPath) ||
		isEffectParamPath(propertyPath)
	);
}
