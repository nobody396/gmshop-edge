import { createFileRoute } from "@tanstack/react-router";
import { handleRedeemCutover } from "#/features/redeem-warehouse/server/delivery-cutover";
import { getCloudflareEnv } from "#/server/db.server";
export const Route = createFileRoute("/api/ops/redeem-cutover")({
	server: {
		handlers: {
			GET: ({ request }) =>
				handleRedeemCutover(request, getCloudflareEnv(request)),
			POST: ({ request }) =>
				handleRedeemCutover(request, getCloudflareEnv(request)),
		},
	},
});
