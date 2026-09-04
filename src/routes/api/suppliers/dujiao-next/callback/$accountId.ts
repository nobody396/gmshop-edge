import { createFileRoute } from "@tanstack/react-router";
import { handleDujiaoSupplierCallback } from "#/features/suppliers/server/dujiao-callback";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute(
	"/api/suppliers/dujiao-next/callback/$accountId",
)({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const { DB, FILES } = getCloudflareEnv(request);
				if (!DB)
					return Response.json(
						{ ok: false, message: "service_unavailable" },
						{ status: 503 },
					);
				return handleDujiaoSupplierCallback(
					request,
					params.accountId,
					DB,
					Date.now(),
					FILES,
				);
			},
		},
	},
});
