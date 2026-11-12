import { createFileRoute } from "@tanstack/react-router";
import { StorefrontMePage } from "#/features/storefront/pages/me";
import { utilityPageHead } from "#/lib/seo";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/(public)/me")({
	head: ({ matches }) =>
		utilityPageHead({ title: m.store_my_title(), matches }),
	component: StorefrontMePage,
});
