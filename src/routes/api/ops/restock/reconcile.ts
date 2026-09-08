import { createFileRoute } from "@tanstack/react-router";
import { handleDeliveryReconcileRequest } from "#/features/catalog/server/restock-api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/restock/reconcile")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleDeliveryReconcileRequest(request, getCloudflareEnv(request)),
		},
	},
});
