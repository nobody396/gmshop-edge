import { queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import type { storefrontCatalogSchema } from "#/features/storefront/schema";
import { listStorefrontCatalogFn } from "#/features/storefront/server/catalog";

export type StorefrontCatalogInput = z.output<typeof storefrontCatalogSchema>;

export function storefrontCatalogQueryOptions(input: StorefrontCatalogInput) {
	return queryOptions({
		queryKey: ["storefront", "catalog", input.locale, input],
		queryFn: () => listStorefrontCatalogFn({ data: input }),
		staleTime: 30_000,
	});
}
