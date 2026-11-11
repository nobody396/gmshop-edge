import { createFileRoute } from "@tanstack/react-router";
import { appStorePricesPath } from "#/features/appstore-prices/config";
import {
	AppStorePricesPage,
	appStorePricesQueryOptions,
} from "#/features/appstore-prices/page";
import { createArticleSeoHead } from "#/lib/seo";

export const Route = createFileRoute("/(public)/guides/appstore-prices")({
	// Server-loaded so the first HTML already has the price tables.
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(appStorePricesQueryOptions()),
	component: AppStorePricesPage,
	head: ({ matches }) =>
		createArticleSeoHead(matches, {
			title: "各区 App Store 开会员价格对比：ChatGPT、Claude、Gemini",
			description:
				"美区、日区、菲区、土区 App Store 里 ChatGPT、Claude、Google AI 会员价，换算成人民币，每天更新。",
			path: appStorePricesPath,
		}),
});
