import {
	RETIMABLE_ELEMENT_TYPES,
	type TimelineElement,
} from "../ports/timeline";

export function isRetimableElement(
	element: TimelineElement,
): element is TimelineElement & { type: "video" | "audio" } {
	return (RETIMABLE_ELEMENT_TYPES as readonly string[]).includes(element.type);
}
