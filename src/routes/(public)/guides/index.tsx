import { createFileRoute } from "@tanstack/react-router";
import { GuidesIndexPage } from "#/features/guides/pages/guides-index-page";
import { publicGuideListQueryOptions } from "#/features/guides/queries";
import { createGuidesIndexSeoHead } from "#/features/guides/seo";
import { siteNameFromMatches } from "#/lib/seo";

export const Route = createFileRoute("/(public)/guides/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicGuideListQueryOptions()),
	head: ({ matches }) => createGuidesIndexSeoHead(siteNameFromMatches(matches)),
	staleTime: 30_000,
	component: GuidesIndexRoute,
});

function GuidesIndexRoute() {
	return <GuidesIndexPage guides={Route.useLoaderData()} />;
}
