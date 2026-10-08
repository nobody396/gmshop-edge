import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { captureReferral } from "./referral-storage";
export function ReferralCapture() {
	const href = useLocation({ select: (location) => location.href });
	useEffect(() => {
		const url = new URL(href, window.location.origin),
			code = url.searchParams.get("ref");
		if (code) captureReferral(code);
	}, [href]);
	return null;
}
