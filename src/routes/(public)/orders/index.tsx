import { createFileRoute } from "@tanstack/react-router";
import { OrderLookupPage } from "#/features/storefront/pages/order-lookup";
import { utilityPageHead } from "#/lib/seo";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/(public)/orders/")({
	head: ({ matches }) =>
		utilityPageHead({ title: m.store_lookup_title(), matches }),
	component: OrderLookupPage,
});
