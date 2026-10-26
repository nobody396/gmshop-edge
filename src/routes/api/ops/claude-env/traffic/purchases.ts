import { createFileRoute } from "@tanstack/react-router";
import { handleClaudeEnvTrafficOps } from "#/features/claude-env/server/traffic-api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/claude-env/traffic/purchases")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleClaudeEnvTrafficOps(
					request,
					getCloudflareEnv(request),
					"purchases",
				),
		},
	},
});
