import { createFileRoute } from "@tanstack/react-router";
import { handleAgentAccessReadyEmailRequest } from "#/features/agent-access/server/ready-email";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/agent-access/ready-email")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleAgentAccessReadyEmailRequest(request, getCloudflareEnv(request)),
		},
	},
});
