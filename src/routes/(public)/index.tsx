import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { HomePage } from "#/features/home";
import { storefrontCatalogQueryOptions } from "#/features/home/catalog-query";
import { storefrontListSchema } from "#/features/storefront/schema";
import { createHomeSeoHead } from "#/lib/seo";
import { getLocale } from "#/paraglide/runtime";

export const Route = createFileRoute("/(public)/")({
	validateSearch: storefrontListSchema,
	loaderDeps: ({ search }) => ({
		search: search.search,
		tag: search.tag,
		sort: search.sort,
	}),
	search: {
		middlewares: [stripSearchParams({ search: "", tag: "", sort: "featured" })],
	},
	loader: async ({ context, deps }) => {
		await context.queryClient.ensureQueryData(
			storefrontCatalogQueryOptions({ ...deps, locale: getLocale() }),
		);
	},
	head: ({ matches }) => createHomeSeoHead(matches),
	staleTime: 30_000,
	component: HomeRoute,
});

function HomeRoute() {
	return <HomePage searchParams={Route.useSearch()} />;
}
