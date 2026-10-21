import { useEffect } from "react";

/** First-party cookie holding the visitor's first landing (first-touch). */
export const firstTouchCookieName = "gmshop_ft";
const MAX_AGE_SECONDS = 30 * 86_400;

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
};

function clip(value: string | null | undefined, limit: number) {
	const trimmed = value?.trim();
	return trimmed ? trimmed.slice(0, limit) : undefined;
}

export function captureFirstTouch(input: {
	href: string;
	referrer: string;
	now: number;
}): FirstTouch {
	const url = new URL(input.href);
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
	return {
		v: 1,
		r: clip(referrerHost, 253),
		s: clip(url.searchParams.get("utm_source"), 100),
		m: clip(url.searchParams.get("utm_medium"), 100),
		c: clip(url.searchParams.get("utm_campaign"), 150),
		p: clip(url.pathname, 200) ?? "/",
		t: input.now,
	};
}

/** Records the first landing once; later visits never overwrite it. */
export function useFirstTouchAttribution() {
	useEffect(() => {
		try {
			if (
				document.cookie
					.split(";")
					.some((part) => part.trim().startsWith(`${firstTouchCookieName}=`))
			)
				return;
			const touch = captureFirstTouch({
				href: window.location.href,
				referrer: document.referrer,
				now: Date.now(),
			});
			const secure = window.location.protocol === "https:" ? "; Secure" : "";
			// biome-ignore lint/suspicious/noDocumentCookie: plain first-party cookie that the checkout request carries to the server.
			document.cookie = `${firstTouchCookieName}=${encodeURIComponent(JSON.stringify(touch))}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
		} catch {
			// Attribution must never affect browsing.
		}
	}, []);
}
