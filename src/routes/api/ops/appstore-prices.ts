import { createFileRoute } from "@tanstack/react-router";
import { handleAppStorePricesIngest } from "#/features/appstore-prices/server/store";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/appstore-prices")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleAppStorePricesIngest(request, getCloudflareEnv(request)),
		},
	},
});
