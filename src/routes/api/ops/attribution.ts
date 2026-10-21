import { createFileRoute } from "@tanstack/react-router";
import { handleAttributionReportRequest } from "#/features/attribution/server/report";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/attribution")({
	server: {
		handlers: {
			GET: ({ request }) =>
				handleAttributionReportRequest(request, getCloudflareEnv(request)),
		},
	},
});
