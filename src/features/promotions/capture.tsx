import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { deviceCookieName, isDeviceId } from "./device";
import { captureReferral } from "./referral-storage";

/** Tags this browser once (2 years) so referral rewards can tell the referrer's own browser apart. */
export function ensureDeviceCookie() {
	if (typeof document === "undefined") return;
	try {
		const current = document.cookie
			.split("; ")
			.find((part) => part.startsWith(`${deviceCookieName}=`))
			?.slice(deviceCookieName.length + 1);
		if (isDeviceId(current)) return;
		const id = crypto.randomUUID().replaceAll("-", "");
		Reflect.set(
			document,
			"cookie",
			`${deviceCookieName}=${id}; Path=/; SameSite=Lax; Secure; Max-Age=${2 * 365 * 86400}`,
		);
	} catch {
		/* Cookies may be blocked; the reward check then simply has no device to compare. */
	}
}

// Set before any server call on first load so the request already carries the tag.
ensureDeviceCookie();

export function ReferralCapture() {
	const href = useLocation({ select: (location) => location.href });
	useEffect(() => {
		ensureDeviceCookie();
		const url = new URL(href, window.location.origin),
			code = url.searchParams.get("ref");
		if (code) captureReferral(code);
	}, [href]);
	return null;
}
