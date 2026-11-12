import { createFileRoute } from "@tanstack/react-router";
import { appStorePricesPath } from "#/features/appstore-prices/config";
import {
	AppStorePricesPage,
	appStorePricesQueryOptions,
} from "#/features/appstore-prices/page";
import { staticGuidePage } from "#/features/guides/content";
import { createArticleSeoHead } from "#/lib/seo";

const page = staticGuidePage("appstore-prices");

export const Route = createFileRoute("/(public)/guides/appstore-prices")({
	// Server-loaded so the first HTML already has the price tables.
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(appStorePricesQueryOptions()),
	component: AppStorePricesPage,
	head: ({ matches }) =>
		createArticleSeoHead(matches, {
			title: page.title,
			description: page.seoDescription,
			path: appStorePricesPath,
		}),
});
