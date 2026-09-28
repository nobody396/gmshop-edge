import { createFileRoute } from "@tanstack/react-router";
import { currentWebSupportConversation } from "#/features/telegram/server/web-support";
import { webSupportResponse } from "#/features/telegram/server/web-support-route";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/support/web/current")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					const raw = new URL(request.url).searchParams.get("after") ?? "0";
					const after = /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
					return Response.json(
						await currentWebSupportConversation(getEnv().DB, request, after),
						{ headers: { "cache-control": "private, no-store" } },
					);
				} catch (error) {
					return webSupportResponse(error);
				}
			},
		},
	},
});
