import { useEffect, useState } from "react";

/**
 * Top offset for a sticky column. A column that fits the viewport pins below
 * the header; a taller one would hide its own bottom (the buy buttons) while
 * pinned, so it scrolls with the page and pins once its bottom is in view.
 */
export function stickyTop(
	columnHeight: number,
	viewportHeight: number,
	headerOffset: number,
	bottomGap = 16,
) {
	return Math.min(headerOffset, viewportHeight - columnHeight - bottomGap);
}

/** Returns the top offset and a callback ref for the sticky column. */
export function useFitStickyTop(headerOffset: number) {
	const [element, setElement] = useState<HTMLElement | null>(null);
	const [top, setTop] = useState(headerOffset);
	useEffect(() => {
		if (!element) return;
		const update = () =>
			setTop(stickyTop(element.offsetHeight, window.innerHeight, headerOffset));
		update();
		const observer =
			typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
		observer?.observe(element);
		window.addEventListener("resize", update);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [element, headerOffset]);
	return [top, setElement] as const;
}

/**
 * Live height of the sticky public header, so a bar pinned under it uses the
 * header's real size (mobile vs desktop row, safe-area padding) instead of a
 * hard-coded breakpoint offset.
 */
export function usePublicHeaderHeight(fallback = 56) {
	const [height, setHeight] = useState(fallback);
	useEffect(() => {
		const header = document.querySelector<HTMLElement>("[data-public-header]");
		if (!header) return;
		const update = () => setHeight(header.offsetHeight);
		update();
		const observer =
			typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
		observer?.observe(header);
		window.addEventListener("resize", update);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", update);
		};
	}, []);
	return height;
}
