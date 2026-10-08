import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAgent } from "#/features/agent-access/server/client";
import { runWithRuntimeEnv } from "#/server/runtime/context";

afterEach(() => vi.unstubAllGlobals());
describe("paid agent access boundaries", () => {
	it("signs the exact request and uses fresh transport nonces while retaining business identity", async () => {
		const requests: Array<{ body: string; headers: Headers; url: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				requests.push({
					url,
					body: String(init.body),
					headers: new Headers(init.headers),
				});
				expect(init.redirect).toBe("manual");
				return Response.json({ state: "active", userId: 1 });
			}),
		);
		const input = {
			operation: "provision" as const,
			sourceUserId: "buyer",
			email: "buyer@example.test",
			kind: "api" as const,
			orderItemId: "order-item",
		};
		const secret = "synthetic-test-only-bridge-signing-key";
		await runWithRuntimeEnv(
			{ runtime: "bun", AGENT_ACCESS_SIGNING_KEY: secret },
			async () => {
				await callAgent(input);
				await callAgent(input);
			},
		);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.body).toBe(requests[1]?.body);
		expect(requests[0]?.headers.get("X-Agent-Nonce")).not.toBe(
			requests[1]?.headers.get("X-Agent-Nonce"),
		);
		const r = requests[0];
		if (!r) throw new Error("request missing");
		expect(r.url).toBe("https://lsrai.shop/api/v1/internal/agent-access");
		const e = new TextEncoder();
		const hex = (b: ArrayBuffer) =>
			Array.from(new Uint8Array(b), (x) =>
				x.toString(16).padStart(2, "0"),
			).join("");
		const hash = hex(await crypto.subtle.digest("SHA-256", e.encode(r.body)));
		const key = await crypto.subtle.importKey(
			"raw",
			e.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signature = hex(
			await crypto.subtle.sign(
				"HMAC",
				key,
				e.encode(
					`POST\n/api/v1/internal/agent-access\n${r.headers.get("X-Agent-Timestamp")}\n${r.headers.get("X-Agent-Nonce")}\n${hash}`,
				),
			),
		);
		expect(r.headers.get("X-Agent-Signature")).toBe(signature);
		expect(r.body).not.toContain(secret);
	});
	it("fails closed without runtime credentials, before sending any request", async () => {
		const f = vi.fn();
		vi.stubGlobal("fetch", f);
		await expect(
			runWithRuntimeEnv({ runtime: "bun" }, () =>
				callAgent({
					operation: "check",
					sourceUserId: "buyer",
					email: "buyer@example.test",
					kind: "api",
				}),
			),
		).rejects.toMatchObject({ code: "agent_access_unavailable" });
		expect(f).not.toHaveBeenCalled();
	});
	it("binds private delivery reads to both the order owner and grant owner, not an email or order number alone", async () => {
		const text = await readFile(
			new URL(
				"../../src/features/agent-access/server/functions.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(text).toContain(
			"resolveStoreAccount(db, request, { required: true })",
		);
		expect(text).toContain("o.user_id=? AND a.user_id=?");
		expect(text).toContain(".bind(orderNumber, userId, userId)");
		expect(text).toContain('setResponseHeader("Cache-Control", "no-store")');
		expect(text).toContain("sameOrigin(request)");
		expect(text).not.toContain("api_secret");
	});
});
