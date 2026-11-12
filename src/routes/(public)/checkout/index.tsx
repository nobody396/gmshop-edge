import { createFileRoute } from "@tanstack/react-router";
import { StorefrontCheckoutPage } from "#/features/storefront/pages/checkout";
import { checkoutSearchSchema } from "#/features/storefront/schema";
import { utilityPageHead } from "#/lib/seo";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/(public)/checkout/")({
	head: ({ matches }) =>
		utilityPageHead({ title: m.store_checkout_title(), matches }),
	component: StorefrontCheckoutPage,
	validateSearch: checkoutSearchSchema,
});
