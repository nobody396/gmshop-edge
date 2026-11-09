import { useEffect, useState } from "react";
import { useSiteBrand } from "#/context/site-brand-provider";
import { m } from "#/paraglide/messages";

// The page is server-rendered, so the splash only adds wait time: show the
// brand once per browser tab, briefly, and never on later page loads.
const VISIBLE_MS = 600;
const FADE_DURATION_MS = 350;
export const SPLASH_SEEN_KEY = "startup-splash-seen";

/** Runs before paint so a returning page load never flashes the splash. */
export const SPLASH_BOOT_SCRIPT = `(() => {
  try {
    if (sessionStorage.getItem("${SPLASH_SEEN_KEY}")) document.documentElement.dataset.splash = "seen";
  } catch {}
})();`;

function splashAlreadySeen() {
	try {
		if (sessionStorage.getItem(SPLASH_SEEN_KEY)) return true;
		sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
	} catch {
		// Storage blocked (private mode): fall back to showing it once per load.
	}
	return false;
}

type SplashPhase = "visible" | "fading" | "hidden";

export function StartupSplash() {
	const brand = useSiteBrand();
	const [phase, setPhase] = useState<SplashPhase>("visible");

	useEffect(() => {
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		let fadeTimer: ReturnType<typeof setTimeout> | undefined;
		let hideTimer: ReturnType<typeof setTimeout> | undefined;

		const hideImmediately = () => {
			if (fadeTimer) clearTimeout(fadeTimer);
			if (hideTimer) clearTimeout(hideTimer);
			setPhase("hidden");
		};

		const handleMotionPreference = () => {
			if (reducedMotion.matches) hideImmediately();
		};

		if (splashAlreadySeen() || reducedMotion.matches) {
			hideImmediately();
		} else {
			fadeTimer = setTimeout(() => {
				setPhase("fading");
				hideTimer = setTimeout(() => setPhase("hidden"), FADE_DURATION_MS);
			}, VISIBLE_MS);
			reducedMotion.addEventListener("change", handleMotionPreference);
		}

		return () => {
			if (fadeTimer) clearTimeout(fadeTimer);
			if (hideTimer) clearTimeout(hideTimer);
			reducedMotion.removeEventListener("change", handleMotionPreference);
		};
	}, []);

	if (phase === "hidden") return null;

	return (
		<output
			aria-label={`${brand.name} ${m.common_loading()}`}
			aria-live="polite"
			className="startup-splash"
			data-phase={phase}
		>
			<img
				alt={brand.name}
				className="startup-splash-logo"
				draggable={false}
				height={144}
				src={brand.logoUrl}
				width={144}
			/>
			<div aria-hidden="true" className="startup-splash-track">
				<span className="startup-splash-bar" />
			</div>
		</output>
	);
}
