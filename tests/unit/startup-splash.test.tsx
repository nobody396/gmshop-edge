// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SPLASH_BOOT_SCRIPT,
	SPLASH_SEEN_KEY,
	StartupSplash,
} from "#/components/startup-splash";
import { SiteBrandProvider } from "#/context/site-brand-provider";
import type { SiteBrand } from "#/features/settings/site-brand";

const brand: SiteBrand = {
	name: "Example Shop",
	logoUrl: "/api/site-logo?v=9",
	title: "Example Shop",
	customHtml: "",
	defaultLocale: "en-US",
};

function SplashFixture() {
	return (
		<SiteBrandProvider brand={brand}>
			<StartupSplash />
		</SiteBrandProvider>
	);
}

describe("startup splash", () => {
	let container: HTMLDivElement;
	let root: Root | undefined;
	let reducedMotion = false;
	const listeners = new Set<() => void>();

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		sessionStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: vi.fn(() => ({
				addEventListener: (_event: string, listener: () => void) =>
					listeners.add(listener),
				get matches() {
					return reducedMotion;
				},
				removeEventListener: (_event: string, listener: () => void) =>
					listeners.delete(listener),
			})),
		});
	});

	afterEach(() => {
		if (root) act(() => root?.unmount());
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		container.remove();
		root = undefined;
		reducedMotion = false;
		listeners.clear();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("server-renders the dynamic brand logo without requiring browser APIs", () => {
		const markup = renderToStaticMarkup(<SplashFixture />);

		expect(markup).toContain('src="/api/site-logo?v=9"');
		expect(markup).toContain('alt="Example Shop"');
		expect(markup).toContain("<output");
		expect(markup).toContain('aria-live="polite"');
	});

	it("fades after the minimum display time and then stops rendering", () => {
		root = createRoot(container);
		act(() => root?.render(<SplashFixture />));

		expect(container.querySelector("[data-phase='visible']")).not.toBeNull();

		act(() => vi.advanceTimersByTime(600));
		expect(container.querySelector("[data-phase='fading']")).not.toBeNull();

		act(() => vi.advanceTimersByTime(350));
		expect(container.querySelector(".startup-splash")).toBeNull();
	});

	it("skips the splash on later page loads in the same tab", () => {
		sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
		root = createRoot(container);
		act(() => root?.render(<SplashFixture />));

		expect(container.querySelector(".startup-splash")).toBeNull();
		expect(SPLASH_BOOT_SCRIPT).toContain(SPLASH_SEEN_KEY);
	});

	it("remembers that this tab has seen the splash", () => {
		root = createRoot(container);
		act(() => root?.render(<SplashFixture />));

		expect(sessionStorage.getItem(SPLASH_SEEN_KEY)).toBe("1");
	});

	it("immediately removes itself when reduced motion is preferred", () => {
		reducedMotion = true;
		root = createRoot(container);
		act(() => root?.render(<SplashFixture />));

		expect(container.querySelector(".startup-splash")).toBeNull();
		// jsdom queues a storage event timer; the splash itself must not wait.
		act(() => vi.runAllTimers());
		expect(container.querySelector(".startup-splash")).toBeNull();
	});
});
