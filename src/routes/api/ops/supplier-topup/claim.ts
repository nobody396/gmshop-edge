import { createFileRoute } from "@tanstack/react-router";
import { handleSupplierTopUpClaim } from "#/features/supplier-topup/server/api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/supplier-topup/claim")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleSupplierTopUpClaim(request, getCloudflareEnv(request)),
		},
	},
});
