import { createFileRoute } from "@tanstack/react-router";
import { handleRestockApiRequest } from "#/features/catalog/server/restock-api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/restock")({
	server: {
		handlers: {
			GET: ({ request }) =>
				handleRestockApiRequest(request, getCloudflareEnv(request)),
			POST: ({ request }) =>
				handleRestockApiRequest(request, getCloudflareEnv(request)),
		},
	},
});
