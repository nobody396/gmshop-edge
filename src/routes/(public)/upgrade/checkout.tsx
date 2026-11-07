import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { UpgradeCheckoutPage } from "#/features/gpt-upgrade/pages/checkout";

export const Route = createFileRoute("/(public)/upgrade/checkout")({
	component: UpgradeCheckoutPage,
	validateSearch: z.object({ quote: z.string().max(200).catch("") }),
	head: () => ({
		meta: [
			{ name: "robots", content: "noindex, nofollow" },
			{ name: "referrer", content: "no-referrer" },
		],
	}),
	headers: () => ({
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	}),
});
