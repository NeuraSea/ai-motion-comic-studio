/**
 * Structural browser-event ports for the extracted OpenCut controllers.
 * React MouseEvent/WheelEvent values satisfy these interfaces, while the
 * extraction stays independent from React and its type package.
 */
export interface MouseEventLike {
	button: number;
	clientX: number;
	clientY: number;
	timeStamp: number;
	target: EventTarget;
}

export interface WheelEventLike {
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	deltaX: number;
	deltaY: number;
	deltaMode: number;
}

/** Structural subset consumed by OpenCut element drag and resize starts. */
export interface ElementMouseEventLike extends MouseEventLike {
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	currentTarget: HTMLElement;
	stopPropagation(): void;
	preventDefault(): void;
}
