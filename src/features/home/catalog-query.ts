import { queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import { storefrontCatalogSchema } from "#/features/storefront/schema";
import { listStorefrontCatalogFn } from "#/features/storefront/server/catalog";

export type StorefrontCatalogInput = z.output<typeof storefrontCatalogSchema>;

export function storefrontCatalogQueryOptions(input: StorefrontCatalogInput) {
	const data = storefrontCatalogSchema.parse(input);
	return queryOptions({
		queryKey: [
			"storefront",
			"catalog",
			data.locale,
			data.search,
			data.tag,
			data.sort,
		],
		queryFn: () => listStorefrontCatalogFn({ data }),
		staleTime: 30_000,
	});
}
