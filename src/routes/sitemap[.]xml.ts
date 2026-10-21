import { createFileRoute } from "@tanstack/react-router";
import {
	listIndexedProducts,
	renderSitemap,
	textResponse,
} from "#/features/seo/server/site-index";
import { getDb } from "#/server/db.server";

export const Route = createFileRoute("/sitemap.xml")({
	server: {
		handlers: {
			GET: async ({ request }) =>
				textResponse(
					renderSitemap(await listIndexedProducts(getDb(request).$client)),
					"application/xml; charset=utf-8",
				),
		},
	},
});
