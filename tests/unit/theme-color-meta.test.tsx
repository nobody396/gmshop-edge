// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { THEME_COLORS, ThemeProvider } from "#/context/theme-provider";
import { preferencesStore } from "#/stores/preferences-store";

it("keeps the mobile browser bar the same colour as the page background", () => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	for (const media of [
		"(prefers-color-scheme: light)",
		"(prefers-color-scheme: dark)",
	]) {
		const meta = document.createElement("meta");
		meta.name = "theme-color";
		meta.media = media;
		meta.content = "#000000";
		document.head.appendChild(meta);
	}
	const root = createRoot(document.createElement("div"));
	act(() => root.render(<ThemeProvider>{null}</ThemeProvider>));

	act(() => preferencesStore.actions.setTheme("dark"));
	const colours = () =>
		Array.from(document.querySelectorAll("meta[name='theme-color']")).map(
			(meta) => meta.getAttribute("content"),
		);
	expect(colours()).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);

	act(() => preferencesStore.actions.setTheme("light"));
	expect(colours()).toEqual([THEME_COLORS.light, THEME_COLORS.light]);
	expect(document.querySelector("meta[name='theme-color'][media]")).toBeNull();
	act(() => root.unmount());
});
