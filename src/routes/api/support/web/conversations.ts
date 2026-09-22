import { createFileRoute } from "@tanstack/react-router";
import {
	createWebSupportConversation,
	webSupportCookie,
} from "#/features/telegram/server/web-support";
import {
	readWebSupportBody,
	webSupportResponse,
} from "#/features/telegram/server/web-support-route";
import { webSupportConversationSchema } from "#/features/telegram/web-support-contract";
import { getEnv, getRuntimeEnv } from "#/server/db.server";
import { verifyTurnstile } from "#/server/turnstile";

export const Route = createFileRoute("/api/support/web/conversations")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const challenge = await verifyTurnstile(
					request,
					getRuntimeEnv(),
					getEnv().DB,
				);
				if (challenge) return challenge;
				try {
					const input = await readWebSupportBody(
						request,
						webSupportConversationSchema,
					);
					const result = await createWebSupportConversation(
						getEnv().DB,
						request,
						input,
					);
					const headers = new Headers();
					if (result.sessionToken)
						headers.set("set-cookie", webSupportCookie(result.sessionToken));
					return Response.json(
						{ id: result.id, status: result.status },
						{ headers },
					);
				} catch (error) {
					return webSupportResponse(error);
				}
			},
		},
	},
});
