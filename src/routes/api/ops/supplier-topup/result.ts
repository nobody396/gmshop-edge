import { createFileRoute } from "@tanstack/react-router";
import { handleSupplierTopUpResult } from "#/features/supplier-topup/server/api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/supplier-topup/result")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleSupplierTopUpResult(request, getCloudflareEnv(request)),
		},
	},
});
