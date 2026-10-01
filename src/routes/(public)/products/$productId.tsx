import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { StorefrontProductPage } from "#/features/storefront/pages/product";

export const Route = createFileRoute("/(public)/products/$productId")({
	validateSearch: z.object({ item: z.uuid().optional().catch(undefined) }),
	component: ProductRoute,
});

function ProductRoute() {
	const { productId } = Route.useParams();
	const { item } = Route.useSearch();
	return (
		<StorefrontProductPage
			key={`${productId}:${item ?? ""}`}
			productId={productId}
			preferredItemId={item}
		/>
	);
}
