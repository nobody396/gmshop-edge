import { callAgent } from "#/features/agent-access/server/client";
import { runWithRuntimeEnv } from "#/server/runtime/context";
export default {
	fetch(_request: Request, env: { BRIDGE_SECRET: string }) {
		return runWithRuntimeEnv(
			{ runtime: "cloudflare", AGENT_ACCESS_SIGNING_KEY: env.BRIDGE_SECRET },
			async () => {
				try {
					const r = await callAgent({
						operation: "check",
						sourceUserId: "runtime-fixture",
						email: "fixture@example.test",
						kind: "api",
					});
					return Response.json({ ok: true, state: r.state });
				} catch (e) {
					return Response.json({
						ok: false,
						name: e instanceof Error ? e.name : "unknown",
						message: e instanceof Error ? e.message : "",
						code: e && typeof e === "object" && "code" in e ? e.code : null,
					});
				}
			},
		);
	},
};
