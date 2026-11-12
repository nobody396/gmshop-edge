import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { RenewalUnsubscribePage } from "#/features/renewals/pages/unsubscribe";
import { utilityPageHead } from "#/lib/seo";

const searchSchema = z.object({
	e: z.string().max(320).optional().catch(undefined),
	sig: z.string().max(128).optional().catch(undefined),
});

export const Route = createFileRoute("/(public)/unsubscribe/renewal")({
	validateSearch: searchSchema,
	head: () => utilityPageHead({ nofollow: true }),
	component: RenewalUnsubscribeRoute,
});

function RenewalUnsubscribeRoute() {
	const search = Route.useSearch();
	return <RenewalUnsubscribePage email={search.e} signature={search.sig} />;
}
