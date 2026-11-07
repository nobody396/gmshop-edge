import { afterEach, describe, expect, it, vi } from "vitest";

const sendOwnerAlert = vi.fn(async () => ({ channel: "telegram" as const }));
vi.mock("#/features/telegram/server/owner-alerts", () => ({ sendOwnerAlert }));

const {
	codePrefixAlertIntervalMs,
	loadRenewalCodePrefixes,
	redeemCodePrefixesUrl,
} = await import("#/features/renewals/server/code-prefixes");
const { redeemCodePrefixes } = await import("#/features/renewals/domain");

/** Minimal system_settings row store honouring the claim's WHERE clause. */
function fakeDb() {
	let updatedAt: number | null = null;
	const db = {
		prepare: () => ({
			bind: (...args: unknown[]) => ({
				run: async () => {
					const [, , , now, cutoff] = args as [
						string,
						string,
						number,
						number,
						number,
					];
					if (updatedAt === null || updatedAt <= cutoff) {
						updatedAt = now;
						return { meta: { changes: 1 } };
					}
					return { meta: { changes: 0 } };
				},
			}),
		}),
	};
	return db as unknown as D1Database;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

describe("loadRenewalCodePrefixes", () => {
	afterEach(() => sendOwnerAlert.mockClear());

	it("merges the live list with the built-in floor", async () => {
		const fetcher = vi.fn(async () =>
			json({ version: 1, prefixes: ["gpt-999-zz", "gpt-plus-ph"] }),
		);
		const prefixes = await loadRenewalCodePrefixes(fakeDb(), {
			fetcher: fetcher as unknown as typeof fetch,
		});
		expect(fetcher).toHaveBeenCalledWith(
			redeemCodePrefixesUrl,
			expect.anything(),
		);
		expect(prefixes).toContain("gpt-999-zz");
		for (const prefix of redeemCodePrefixes) expect(prefixes).toContain(prefix);
		expect(new Set(prefixes).size).toBe(prefixes.length);
		expect(sendOwnerAlert).not.toHaveBeenCalled();
	});

	it.each([
		["an HTTP error", () => json({}, 503)],
		["an empty list", () => json({ version: 1, prefixes: [] })],
		[
			"a malformed prefix",
			() => json({ version: 1, prefixes: ["bad prefix"] }),
		],
		["an unknown version", () => json({ version: 2, prefixes: ["x"] })],
		["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
	])("falls back to the built-in list on %s and alerts once per 6h", async (_, answer) => {
		const db = fakeDb();
		const fetcher = vi.fn(answer) as unknown as typeof fetch;
		const now = Date.parse("2026-11-07T02:00:00Z");
		const first = await loadRenewalCodePrefixes(db, { fetcher, now });
		expect(first).toEqual(redeemCodePrefixes);
		await loadRenewalCodePrefixes(db, { fetcher, now: now + 600_000 });
		expect(sendOwnerAlert).toHaveBeenCalledTimes(1);
		await loadRenewalCodePrefixes(db, {
			fetcher,
			now: now + codePrefixAlertIntervalMs,
		});
		expect(sendOwnerAlert).toHaveBeenCalledTimes(2);
	});

	it("still answers when the alert itself fails", async () => {
		sendOwnerAlert.mockRejectedValueOnce(new Error("telegram down"));
		const prefixes = await loadRenewalCodePrefixes(fakeDb(), {
			fetcher: (async () => json({}, 500)) as unknown as typeof fetch,
		});
		expect(prefixes).toEqual(redeemCodePrefixes);
	});
});
