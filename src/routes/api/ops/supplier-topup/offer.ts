import { createFileRoute } from "@tanstack/react-router";
import { handleSupplierTopUpOffer } from "#/features/supplier-topup/server/api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/supplier-topup/offer")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleSupplierTopUpOffer(request, getCloudflareEnv(request)),
		},
	},
});
