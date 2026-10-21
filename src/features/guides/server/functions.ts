import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { getDb } from "#/server/db.server";
import { loadPublicGuide, loadPublicGuideList } from "./public-guide";

const slugInputSchema = z.object({ slug: z.string().max(120) });

/** Published guide with live prices; null for unknown, draft or reserved slugs. */
export const getPublicGuideFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof slugInputSchema>) =>
		slugInputSchema.parse(input),
	)
	.handler(async ({ data }) =>
		loadPublicGuide(getDb(getRequest()).$client, data.slug),
	);

export const listPublicGuidesFn = createServerFn({ method: "GET" }).handler(
	async () => loadPublicGuideList(getDb(getRequest()).$client),
);
