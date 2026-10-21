import { createFileRoute, notFound } from "@tanstack/react-router";
import { guideSlugSchema } from "#/features/guides/content";
import { GuidePage } from "#/features/guides/pages/guide-page";
import { publicGuideQueryOptions } from "#/features/guides/queries";
import { createGuideSeoHead } from "#/features/guides/seo";
import { siteNameFromMatches } from "#/lib/seo";

export const Route = createFileRoute("/(public)/guides/$slug")({
	// Server-loaded so the article, prices and JSON-LD are in the first HTML;
	// unknown, draft and malformed slugs are a real 404.
	loader: async ({ context, params }) => {
		if (!guideSlugSchema.safeParse(params.slug).success) throw notFound();
		const guide = await context.queryClient.ensureQueryData(
			publicGuideQueryOptions(params.slug),
		);
		if (!guide) throw notFound();
		return guide;
	},
	head: ({ loaderData, matches }) =>
		loaderData
			? createGuideSeoHead(loaderData, siteNameFromMatches(matches))
			: {},
	staleTime: 30_000,
	component: GuideRoute,
});

function GuideRoute() {
	return <GuidePage guide={Route.useLoaderData()} />;
}
