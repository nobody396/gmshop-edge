import { useEffect } from "react";
import { detectInAppBrowser, type InAppBrowser, isInviteRef } from "./sources";

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

// Hosts a customer comes back from mid-purchase; a return from checkout is not
// a new marketing touch.
const paymentHosts = [
	"alipay.com",
	"alipayobjects.com",
	"stripe.com",
	"cryptomus.com",
	"zpayz.cn",
	"tenpay.com",
	"pay.weixin.qq.com",
	"paypal.com",
];

function sameSiteOrPayment(host: string, siteHost: string) {
	const site = siteHost.replace(/^www\./, "");
	return [site, ...paymentHosts].some(
		(domain) => host === domain || host.endsWith(`.${domain}`),
	);
}

/**
 * Whether a landing should replace the last-touch cookie: campaign tags, an
 * invite code or an external referrer (not our own subdomains or a payment
 * page). An in-app browser alone counts only on a tab's first landing, so
 * reloads inside WeChat do not erase the email click that opened the page.
 */
export function lastTouchFrom(
	touch: Touch,
	siteHost: string,
	firstLandingInTab: boolean,
): Touch | null {
	const referrer =
		touch.r && !sameSiteOrPayment(touch.r, siteHost) ? touch.r : undefined;
	const tagged = Boolean(touch.s || touch.m || touch.c || touch.f);
	if (!tagged && !referrer && !(touch.i && firstLandingInTab)) return null;
	const { r: _dropped, ...rest } = touch;
	return referrer ? { ...rest, r: referrer } : rest;
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
			const touch = captureFirstTouch({
				href: window.location.href,
				referrer: document.referrer,
				now: Date.now(),
				userAgent: navigator.userAgent,
				telegramWebview: "TelegramWebviewProxy" in window,
			});
			if (!readCookie(firstTouchCookieName))
				writeCookie(firstTouchCookieName, touch);
			const last = lastTouchFrom(
				touch,
				window.location.hostname,
				firstLandingInTab(),
			);
			if (last) writeCookie(lastTouchCookieName, last);
		} catch {
			// Attribution must never affect browsing.
		}
	}, []);
}
