import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { storeCurrencyConfigurationQueryOptions } from "#/features/exchange-rates/currency-context";
import {
	guideProducts,
	retiredTwentyRenewProductId,
} from "#/features/home/buying-guide-rules";
import { StorefrontProductPage } from "#/features/storefront/pages/product";
import {
	createProductSeoHead,
	storefrontProductQueryOptions,
} from "#/features/storefront/product-seo";
import { siteNameFromMatches } from "#/lib/seo";
import { getLocale } from "#/paraglide/runtime";

export const Route = createFileRoute("/(public)/products/$productId")({
	validateSearch: z.object({
		item: z.uuid().optional().catch(undefined),
		src: z.enum(["order", "redeem"]).optional().catch(undefined),
	}),
	beforeLoad: ({ params }) => {
		if (params.productId === retiredTwentyRenewProductId) {
			throw redirect({
				to: "/products/$productId",
				params: { productId: guideProducts.twentyrenew.productId },
				search: { item: guideProducts.twentyrenew.itemId },
				hash: "purchase-options",
				replace: true,
			});
		}
	},
	// Loading on the server puts the name, plans, prices and stock into the
	// first HTML response; unknown or unlisted products are a real 404.
	loader: async ({ context, params }) => {
		if (!z.uuid().safeParse(params.productId).success) throw notFound();
		try {
			const [product] = await Promise.all([
				context.queryClient.ensureQueryData(
					storefrontProductQueryOptions({
						locale: getLocale(),
						productId: params.productId,
					}),
				),
				context.queryClient
					.ensureQueryData(storeCurrencyConfigurationQueryOptions())
					.catch(() => undefined),
			]);
			return product;
		} catch (error) {
			if (isProductNotFound(error)) throw notFound();
			throw error;
		}
	},
	head: ({ loaderData, matches }) =>
		loaderData
			? createProductSeoHead(loaderData, siteNameFromMatches(matches))
			: {},
	staleTime: 30_000,
	component: ProductRoute,
});

function isProductNotFound(error: unknown) {
	if (!error || typeof error !== "object") return false;
	const { code, status } = error as { code?: unknown; status?: unknown };
	return code === "product_not_found" || status === 404;
}

function ProductRoute() {
	const { productId } = Route.useParams();
	const { item, src } = Route.useSearch();
	return (
		<StorefrontProductPage
			key={`${productId}:${item ?? ""}`}
			productId={productId}
			preferredItemId={item}
			landingSource={src}
		/>
	);
}
