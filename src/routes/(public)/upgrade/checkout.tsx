import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { UpgradeCheckoutPage } from "#/features/gpt-upgrade/pages/checkout";
import { utilityPageHead } from "#/lib/seo";

export const Route = createFileRoute("/(public)/upgrade/checkout")({
	component: UpgradeCheckoutPage,
	validateSearch: z.object({ quote: z.string().max(200).catch("") }),
	head: () => ({
		meta: [
			...utilityPageHead({ nofollow: true }).meta,
			{ name: "referrer", content: "no-referrer" },
		],
	}),
	headers: () => ({
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	}),
});
