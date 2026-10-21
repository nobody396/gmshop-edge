import { createFileRoute } from "@tanstack/react-router";
import { handleGuidesOpsRequest } from "#/features/guides/server/ops-api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/guides/")({
	server: {
		handlers: {
			GET: ({ request }) =>
				handleGuidesOpsRequest(request, getCloudflareEnv(request)),
		},
	},
});
