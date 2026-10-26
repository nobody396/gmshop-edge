import { createFileRoute } from "@tanstack/react-router";
import { handleRelayApiRequest } from "#/features/claude-env/server/relay-api";
import { activateReady } from "#/features/claude-env/server/scheduler";
import { publishPendingNotifications } from "#/features/notifications/server/delivery";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/claude-env/relay/v1/report")({
	server: {
		handlers: {
			POST: ({ request }) => {
				const env = getCloudflareEnv(request);
				const db = env.DB;
				if (!db)
					return Response.json(
						{ ok: false, error: "unavailable" },
						{ status: 503 },
					);
				return handleRelayApiRequest(request, {
					db,
					// Activate (and send the ready email) as soon as the relay
					// confirms, instead of on the next minute's cron.
					onReady: async () => {
						const { activated } = await activateReady({ db });
						if (activated > 0 && env.COMMERCE_QUEUE)
							await publishPendingNotifications(db, env.COMMERCE_QUEUE);
					},
				});
			},
		},
	},
});
