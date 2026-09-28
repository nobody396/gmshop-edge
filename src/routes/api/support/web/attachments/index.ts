import { createFileRoute } from "@tanstack/react-router";
import { uploadWebSupportAttachment } from "#/features/telegram/server/web-support-attachments";
import { webSupportResponse } from "#/features/telegram/server/web-support-route";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/support/web/attachments/")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				try {
					return Response.json(
						await uploadWebSupportAttachment(getEnv().DB, request),
					);
				} catch (error) {
					return webSupportResponse(error);
				}
			},
		},
	},
});
