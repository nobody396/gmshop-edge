import { createFileRoute } from "@tanstack/react-router";
import { downloadWebSupportAttachment } from "#/features/telegram/server/web-support-attachments";
import { webSupportResponse } from "#/features/telegram/server/web-support-route";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute(
	"/api/support/web/attachments/$attachmentId",
)({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				try {
					return await downloadWebSupportAttachment(
						getEnv().DB,
						request,
						params.attachmentId,
					);
				} catch (error) {
					return webSupportResponse(error);
				}
			},
		},
	},
});
