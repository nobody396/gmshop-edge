import { queryOptions } from "@tanstack/react-query";
import {
	getPublicGuideFn,
	listPublicGuidesFn,
} from "#/features/guides/server/functions";

export type PublicGuideData = NonNullable<
	Awaited<ReturnType<typeof getPublicGuideFn>>
>;
export type PublicGuideListData = Awaited<
	ReturnType<typeof listPublicGuidesFn>
>;

/** Shared by the SSR loader and the client so the first HTML has the article. */
export function publicGuideQueryOptions(slug: string) {
	return queryOptions({
		queryKey: ["storefront", "guide", slug],
		queryFn: () => getPublicGuideFn({ data: { slug } }),
		staleTime: 30_000,
	});
}

export function publicGuideListQueryOptions() {
	return queryOptions({
		queryKey: ["storefront", "guides"],
		queryFn: () => listPublicGuidesFn(),
		staleTime: 30_000,
	});
}
