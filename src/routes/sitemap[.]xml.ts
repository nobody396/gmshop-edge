import { createFileRoute } from "@tanstack/react-router";
import {
	listIndexedGuides,
	listIndexedProducts,
	renderSitemap,
	textResponse,
} from "#/features/seo/server/site-index";
import { getDb } from "#/server/db.server";

export const Route = createFileRoute("/sitemap.xml")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const db = getDb(request).$client;
				const [products, guides] = await Promise.all([
					listIndexedProducts(db),
					listIndexedGuides(db),
				]);
				return textResponse(
					renderSitemap(products, guides),
					"application/xml; charset=utf-8",
				);
			},
		},
	},
});
