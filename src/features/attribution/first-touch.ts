import { useEffect } from "react";
import {
	detectInAppBrowser,
	type InAppBrowser,
	isFlowHost,
	isInviteRef,
} from "./sources";

/** First-party cookie holding the visitor's first landing (first-touch). */
export const firstTouchCookieName = "gmshop_ft";
/** First-party cookie holding the most recent non-direct landing (last-touch). */
export const lastTouchCookieName = "gmshop_lt";
const MAX_AGE_SECONDS = 30 * 86_400;
/** Marks a tab session whose landing was already considered for last-touch. */
const sessionLandingKey = "gmshop_lt_landing";

export type FirstTouch = {
	v: 1;
	/** Referrer host, external sites only. */
	r?: string;
	s?: string;
	m?: string;
	c?: string;
	/** Landing path without the query string. */
	p: string;
	/** First seen, epoch milliseconds. */
	t: number;
	/** In-app browser (WeChat, Telegram, QQ) detected from the User-Agent. */
	i?: InAppBrowser;
	/** 1 when the landing carried an invite code (`?ref=INV-…`). */
	f?: 1;
};
export type Touch = FirstTouch;

function clip(value: string | null | undefined, limit: number) {
	const trimmed = value?.trim();
	return trimmed ? trimmed.slice(0, limit) : undefined;
}

const campaignParams = ["utm_source", "utm_medium", "utm_campaign", "ref"];

/**
 * A signed-out visitor opening a tagged account link is redirected server-side
 * to `/sign-in?redirect=/account?utm_…`; the tags and intended path then live
 * in the same-site `redirect` parameter.
 */
function landingUrl(url: URL) {
	if (campaignParams.some((key) => url.searchParams.has(key))) return url;
	const redirect = url.searchParams.get("redirect");
	if (!redirect) return url;
	try {
		const target = new URL(redirect, url.origin);
		return target.origin === url.origin &&
			campaignParams.some((key) => target.searchParams.has(key))
			? target
			: url;
	} catch {
		return url;
	}
}

export function captureFirstTouch(input: {
	href: string;
	referrer: string;
	now: number;
	userAgent?: string;
	telegramWebview?: boolean;
}): FirstTouch {
	const url = landingUrl(new URL(input.href));
	let referrerHost: string | undefined;
	try {
		const referrer = input.referrer ? new URL(input.referrer) : null;
		if (
			referrer &&
			/^https?:$/.test(referrer.protocol) &&
			referrer.host !== url.host
		)
			referrerHost = referrer.hostname.toLowerCase();
	} catch {
		referrerHost = undefined;
	}
	const inApp = detectInAppBrowser(input.userAgent, input.telegramWebview);
	return {
		v: 1,
		r: clip(referrerHost, 253),
		s: clip(url.searchParams.get("utm_source"), 100),
		m: clip(url.searchParams.get("utm_medium"), 100),
		c: clip(url.searchParams.get("utm_campaign"), 150),
		p: clip(url.pathname, 200) ?? "/",
		t: input.now,
		...(inApp ? { i: inApp } : {}),
		...(isInviteRef(url.searchParams.get("ref")) ? { f: 1 as const } : {}),
	};
}

function sameSiteOrFlow(host: string, siteHost: string) {
	const site = siteHost.replace(/^www\./, "");
	return host === site || host.endsWith(`.${site}`) || isFlowHost(host);
}

// Where checkout and sign-in returns land; untagged, they are never a new touch.
const returnPath =
	/^\/(?:(?:account\/)?orders|sign-in|register|forgot-password|verify-email-sent|api\/auth)(?:\/|$)/;

function carriesSource(touch: Touch) {
	return Boolean(touch.s || touch.m || touch.c || touch.f || touch.r);
}

/**
 * The touch to store as first touch: a referrer from one of our own flows
 * (sign-in provider, payment, challenge) or any referrer on a return from a
 * social sign-in is dropped, never recorded as where the visitor came from.
 */
export function firstTouchFrom(touch: Touch, authReturn = false): Touch {
	if (!touch.r || !(authReturn || isFlowHost(touch.r))) return touch;
	const { r: _dropped, ...rest } = touch;
	return rest;
}

/**
 * Whether a landing should replace the last-touch cookie: campaign tags, an
 * invite code or an external referrer. Never written: a landing referred by a
 * payment page, sign-in provider, challenge page or one of our own subdomains;
 * the return from a social sign-in this tab started; an untagged order or
 * sign-in page. An in-app browser alone counts only on a tab's first landing
 * and never replaces a last touch that carries tags, an invite or a referrer.
 */
export function lastTouchFrom(
	touch: Touch,
	siteHost: string,
	firstLandingInTab: boolean,
	existing: Touch | null = null,
	authReturn = false,
): Touch | null {
	if (authReturn) return null;
	if (touch.r && sameSiteOrFlow(touch.r, siteHost)) return null;
	const tagged = Boolean(touch.s || touch.m || touch.c || touch.f);
	if (tagged || touch.r) return touch;
	if (returnPath.test(touch.p)) return null;
	return touch.i && firstLandingInTab && !(existing && carriesSource(existing))
		? touch
		: null;
}

const authRedirectKey = "gmshop_auth_redirect";
const authReturnWindowMs = 30 * 60_000;

/** Call right before leaving for a social sign-in provider. */
export function markAuthRedirect() {
	try {
		sessionStorage.setItem(authRedirectKey, String(Date.now()));
	} catch {
		// Without storage the provider-host rules still apply.
	}
}

/** True once for the first page load after a social sign-in this tab started. */
function consumeAuthReturn(now: number) {
	try {
		const startedAt = Number(sessionStorage.getItem(authRedirectKey));
		sessionStorage.removeItem(authRedirectKey);
		return startedAt > 0 && now - startedAt < authReturnWindowMs;
	} catch {
		return false;
	}
}

function readTouchCookie(name: string): Touch | null {
	const raw = document.cookie
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${name}=`))
		?.slice(name.length + 1);
	if (!raw) return null;
	try {
		const value = JSON.parse(decodeURIComponent(raw));
		return value && typeof value === "object" && value.v === 1 ? value : null;
	} catch {
		return null;
	}
}

function readCookie(name: string) {
	return document.cookie
		.split(";")
		.some((part) => part.trim().startsWith(`${name}=`));
}

function writeCookie(name: string, touch: Touch) {
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	// biome-ignore lint/suspicious/noDocumentCookie: plain first-party cookie that the checkout request carries to the server.
	document.cookie = `${name}=${encodeURIComponent(JSON.stringify(touch))}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

function firstLandingInTab() {
	try {
		if (sessionStorage.getItem(sessionLandingKey)) return false;
		sessionStorage.setItem(sessionLandingKey, "1");
		return true;
	} catch {
		return true;
	}
}

/**
 * Records the first landing once (later visits never overwrite it) and the
 * latest non-direct landing on every full page load.
 */
export function useFirstTouchAttribution() {
	useEffect(() => {
		try {
			const now = Date.now();
			const touch = captureFirstTouch({
				href: window.location.href,
				referrer: document.referrer,
				now,
				userAgent: navigator.userAgent,
				telegramWebview: "TelegramWebviewProxy" in window,
			});
			const authReturn = consumeAuthReturn(now);
			if (!readCookie(firstTouchCookieName))
				writeCookie(firstTouchCookieName, firstTouchFrom(touch, authReturn));
			const last = lastTouchFrom(
				touch,
				window.location.hostname,
				firstLandingInTab(),
				readTouchCookie(lastTouchCookieName),
				authReturn,
			);
			if (last) writeCookie(lastTouchCookieName, last);
		} catch {
			// Attribution must never affect browsing.
		}
	}, []);
}
