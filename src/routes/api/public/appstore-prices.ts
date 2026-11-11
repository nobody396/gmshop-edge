import { createFileRoute } from "@tanstack/react-router";
import { handleAppStorePricesPublic } from "#/features/appstore-prices/server/store";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/public/appstore-prices")({
	server: {
		handlers: {
			GET: ({ request }) =>
				handleAppStorePricesPublic(getCloudflareEnv(request)),
		},
	},
});
