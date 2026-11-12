import { createFileRoute } from "@tanstack/react-router";
import { handleAnnouncementEmailRequest } from "#/features/announcements/server/email";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/announcement-email")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleAnnouncementEmailRequest(request, getCloudflareEnv(request)),
		},
	},
});
