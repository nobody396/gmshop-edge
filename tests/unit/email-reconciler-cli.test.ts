import { afterEach, expect, it, vi } from "vitest";
import { encryptNotificationMessage } from "#/features/notifications/secrets";
import { reconcileEmailDelivery } from "../../scripts/reconcile-email-delivery";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({
		status: 0,
		output: [null, null, null, Buffer.from("mock-test-credential")],
	})),
}));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const args = [
	"--account",
	"account",
	"--database",
	"db",
	"--zone",
	"zone",
	"--since",
	"2026-09-20T00:00:00Z",
	"--until",
	"2026-09-24T00:00:00Z",
];
async function setup() {
	const encrypted = await encryptNotificationMessage(
		JSON.stringify({ to: "buyer@customer.com" }),
		"local-test-secret",
	);
	let state = "accepted";
	const sqls: string[] = [];
	const fetcher = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			const path = String(url);
			if (path.endsWith("/zones/zone"))
				return Response.json({
					success: true,
					result: { name: "shop.com", account: { id: "account" } },
				});
			const payload = JSON.parse(String(init?.body));
			if (path.endsWith("/graphql"))
				return Response.json({
					data: {
						viewer: {
							zones: [
								{
									emailSendingAdaptive: [
										{
											datetime: "2026-09-23T01:00:00Z",
											from: "mail@shop.com",
											to: "buyer@customer.com",
											messageId: "msg-1",
											status: "deliveryFailed",
											errorCause: "mailbox_gmail_unknown",
											errorDetail: "No such user",
											isLastEvent: 1,
										},
									],
								},
							],
						},
					},
				});
			const sql = String(payload.sql);
			sqls.push(sql);
			let results: unknown[] = [];
			if (sql.startsWith("SELECT from_address"))
				results = [{ from_address: "mail@shop.com" }];
			else if (sql.startsWith("SELECT value"))
				results = [{ value: JSON.stringify("local-test-secret") }];
			else if (sql.startsWith("SELECT n.id"))
				results = [
					{
						id: "notice",
						status: state,
						provider_message_id: "msg-1",
						accepted_at: Date.parse("2026-09-22T01:00:00Z"),
						created_at: Date.parse("2026-09-22T01:00:00Z"),
						provider_event_at: null,
						message_encrypted: encrypted,
						from_address: "mail@shop.com",
					},
				];
			else if (sql.startsWith("UPDATE notification")) state = "bounced";
			else if (sql.startsWith("SELECT status"))
				results = [
					{
						status: state,
						provider_event_at: Date.parse("2026-09-23T01:00:00Z"),
					},
				];
			return Response.json({
				success: true,
				result: [{ success: true, results }],
			});
		},
	);
	vi.stubGlobal("fetch", fetcher);
	const output = vi.spyOn(console, "log").mockImplementation(() => {});
	return { sqls, fetcher, output };
}
it("dry-runs the authenticated provider/D1 workflow without writes, sends or private output", async () => {
	const { sqls, fetcher, output } = await setup();
	await reconcileEmailDelivery(args);
	expect(sqls.every((s) => s.startsWith("SELECT"))).toBe(true);
	expect(
		fetcher.mock.calls.every(([u]) => !String(u).includes("/sending/send")),
	).toBe(true);
	const text = output.mock.calls.flat().join("\n");
	expect(text).toContain('"applied":false');
	for (const secret of [
		"mock-test-credential",
		"buyer@customer.com",
		"local-test-secret",
	])
		expect(text).not.toContain(secret);
});
it("executes only evidence/suppression updates and verifies exact readback", async () => {
	const { sqls, output } = await setup();
	await reconcileEmailDelivery([...args, "--execute"]);
	expect(
		sqls.filter((s) => s.startsWith("INSERT") || s.startsWith("UPDATE")),
	).toHaveLength(2);
	expect(sqls.some((s) => s.includes("outbox_events"))).toBe(false);
	expect(output.mock.calls.flat().join("\n")).toContain('"applied":true');
});
it("rejects unsafe windows before accessing credentials or Cloudflare", async () => {
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	await expect(
		reconcileEmailDelivery([
			...args.slice(0, 6),
			"--since",
			"2026-09-01T00:00:00Z",
			"--until",
			"2026-09-24T00:00:00Z",
		]),
	).rejects.toThrow("at most 7 days");
	expect(fetcher).not.toHaveBeenCalled();
});
