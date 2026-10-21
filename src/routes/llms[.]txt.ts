import { createFileRoute } from "@tanstack/react-router";
import {
	listIndexedProducts,
	renderLlmsTxt,
	textResponse,
} from "#/features/seo/server/site-index";
import { loadSiteBrandOrDefault } from "#/features/settings/server/site-brand";
import { getCloudflareEnv, getDb } from "#/server/db.server";

export const Route = createFileRoute("/llms.txt")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const env = getCloudflareEnv(request);
				const db = getDb(request).$client;
				const [products, brand] = await Promise.all([
					listIndexedProducts(db),
					loadSiteBrandOrDefault(db, env.CACHE as KVNamespace | undefined),
				]);
				return textResponse(
					renderLlmsTxt(products, brand.name),
					"text/plain; charset=utf-8",
				);
			},
		},
	},
});
