import { createFileRoute } from "@tanstack/react-router";
import { handleGuidesOpsRequest } from "#/features/guides/server/ops-api";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/guides/$slug/unpublish")({
	server: {
		handlers: {
			POST: ({ request, params }) =>
				handleGuidesOpsRequest(request, getCloudflareEnv(request), {
					slug: params.slug,
					action: "unpublish",
				}),
		},
	},
});
