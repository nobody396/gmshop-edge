import { createFileRoute } from "@tanstack/react-router";
import { handleRelayApiRequest } from "#/features/claude-env/server/relay-api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/claude-env/relay/v1/report")({
	server: {
		handlers: {
			POST: ({ request }) => {
				const db = getCloudflareEnv(request).DB;
				if (!db)
					return Response.json(
						{ ok: false, error: "unavailable" },
						{ status: 503 },
					);
				return handleRelayApiRequest(request, { db });
			},
		},
	},
});
