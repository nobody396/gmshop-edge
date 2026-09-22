import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "#/features/auth/server/auth";
import { getRuntimeEnv } from "#/server/db.server";
import { publicTurnstileConfig, verifyTurnstile } from "#/server/turnstile";

export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			GET: async ({ request }) =>
				new URL(request.url).pathname === "/api/auth/turnstile-config"
					? Response.json(publicTurnstileConfig(getRuntimeEnv()), {
							headers: { "cache-control": "no-store" },
						})
					: (await getAuth(request)).handler(request),
			POST: async ({ request }) =>
				(await verifyTurnstile(request, getRuntimeEnv())) ??
				(await getAuth(request)).handler(request),
		},
	},
});
