import { createFileRoute } from "@tanstack/react-router";
import { handleRedeemRestockRequest } from "#/features/redeem-warehouse/server/restock-api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/redeem-restock")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleRedeemRestockRequest(request, getCloudflareEnv(request)),
		},
	},
});
