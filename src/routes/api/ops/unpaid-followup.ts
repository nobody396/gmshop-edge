import { createFileRoute } from "@tanstack/react-router";
import { handleUnpaidFollowupRequest } from "#/features/unpaid-followup/server/ops";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/unpaid-followup")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleUnpaidFollowupRequest(request, getCloudflareEnv(request)),
		},
	},
});
