import { afterEach, expect, it, vi } from "vitest";
import { callAgent } from "../../src/features/agent-access/server/client";
import { currentRuntimeEnv } from "../../src/server/runtime/context";

vi.mock("@tanstack/react-start/server", () => ({
	createStartHandler: () => vi.fn(),
	defaultStreamHandler: vi.fn(),
}));
vi.mock("../../src/features/ip-check/server/lookup", () => ({
	handleIpCheck: vi.fn(),
}));
vi.mock("../../src/features/status/server/health", () => ({
	handleLivenessRequest: vi.fn(),
}));
vi.mock("../../src/server/http-security", () => ({
	applySecurityHeaders: vi.fn(),
}));
vi.mock("../../src/server/middleware/authority", () => ({
	validateRequestAuthority: vi.fn(),
}));
vi.mock("../../src/server/middleware/gmshop-mirror", () => ({
	authenticateGmshopMirror: vi.fn(),
}));
vi.mock("../../src/server/middleware/i18n", () => ({
	handleI18nRequest: vi.fn(),
}));
vi.mock("../../src/server/queue/drain", () => ({
	drainPendingCommerceOutbox: vi.fn(),
}));
vi.mock("../../src/server/server-timing", () => ({
	appendServerTiming: vi.fn(),
	takeRequestTiming: vi.fn(),
}));

// Replace business work only. Exercise the real Worker event entry, runtime
// adapter/context and signed bridge client after an async boundary.
async function provision() {
	await Promise.resolve();
	return callAgent({
		operation: "provision",
		kind: "api",
		sourceUserId: "test",
		email: "test@example.test",
		orderItemId: "item",
		initialPassword: "Synthetic-password-123!",
	});
}
vi.mock("../../src/server/queue", () => ({ handleQueue: () => provision() }));
vi.mock("../../src/server/scheduled", () => ({
	handleScheduled: (
		_controller: unknown,
		_env: unknown,
		context: ExecutionContext,
	) => {
		context.waitUntil(provision());
	},
}));

const worker = (await import("../../src/server-entry")).default;
afterEach(() => vi.unstubAllGlobals());

for (const event of ["queue", "scheduled"] as const) {
	it(`passes signed bridge bindings through the real ${event} entry`, async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ state: "active", userId: 1 }),
		);
		vi.stubGlobal("fetch", fetcher);
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil: (p: Promise<unknown>) => pending.push(p),
		} as unknown as ExecutionContext;
		const env = {
			AGENT_ACCESS_SIGNING_KEY:
				"synthetic-bridge-secret-at-least-32-characters",
		} as unknown as Env;
		if (event === "queue")
			await worker.queue(
				{ messages: [], queue: "test" } as unknown as MessageBatch<never>,
				env,
				context,
			);
		else
			worker.scheduled(
				{ cron: "* * * * *", scheduledTime: 1 } as ScheduledController,
				env,
				context,
			);
		await Promise.all(pending);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"https://lsrai.shop/api/v1/internal/agent-access",
		);
		expect(() => currentRuntimeEnv()).toThrow(
			"Runtime bindings are unavailable",
		);
	});
}
