// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	markAuthRedirect,
	useFirstTouchAttribution,
} from "#/features/attribution/first-touch";

function Probe() {
	useFirstTouchAttribution();
	return null;
}

function land(path: string, referrer: string) {
	window.history.replaceState(null, "", path);
	Object.defineProperty(document, "referrer", {
		configurable: true,
		value: referrer,
	});
	const container = document.createElement("div");
	const root = createRoot(container);
	act(() => root.render(<Probe />));
	act(() => root.unmount());
}

function cookie(name: string) {
	const raw = document.cookie
		.split("; ")
		.find((part) => part.startsWith(`${name}=`))
		?.slice(name.length + 1);
	return raw ? JSON.parse(decodeURIComponent(raw)) : null;
}

function clearCookies() {
	for (const name of ["gmshop_ft", "gmshop_lt"]) {
		// biome-ignore lint/suspicious/noDocumentCookie: test cleanup of first-party cookies.
		document.cookie = `${name}=; Path=/; Max-Age=0`;
	}
}

describe("first/last touch capture in the browser", () => {
	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		clearCookies();
		sessionStorage.clear();
	});
	afterEach(() => {
		clearCookies();
		sessionStorage.clear();
	});

	it("keeps the email last touch when Google sign-in redirects back", () => {
		land(
			"/account?utm_source=renewal&utm_medium=email&utm_campaign=recall",
			"",
		);
		expect(cookie("gmshop_lt")).toMatchObject({ s: "renewal", c: "recall" });
		sessionStorage.clear();
		land("/account", "https://accounts.google.com/");
		expect(cookie("gmshop_lt")).toMatchObject({ s: "renewal", c: "recall" });
		expect(cookie("gmshop_ft").r).toBeUndefined();
	});

	it("does not record a first-touch referrer from a sign-in provider", () => {
		land("/", "https://accounts.google.com/");
		expect(cookie("gmshop_ft")).toMatchObject({ p: "/" });
		expect(cookie("gmshop_ft").r).toBeUndefined();
		expect(cookie("gmshop_lt")).toBeNull();
	});

	it("skips the one return from a social sign-in this tab started", () => {
		land("/", "https://www.zhihu.com/");
		expect(cookie("gmshop_lt")).toMatchObject({ r: "www.zhihu.com" });
		markAuthRedirect();
		land("/account", "https://github.com/");
		expect(cookie("gmshop_lt")).toMatchObject({ r: "www.zhihu.com" });
		// The mark is used once; a later real GitHub referral counts.
		land("/", "https://github.com/");
		expect(cookie("gmshop_lt")).toMatchObject({ r: "github.com" });
	});
});
