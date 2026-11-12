import { createFileRoute } from "@tanstack/react-router";
import { StorefrontCartPage } from "#/features/storefront/pages/cart";
import { utilityPageHead } from "#/lib/seo";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/(public)/cart")({
	head: ({ matches }) =>
		utilityPageHead({ title: m.store_cart_title(), matches }),
	component: StorefrontCartPage,
});
