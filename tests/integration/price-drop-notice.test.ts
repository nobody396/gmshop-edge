import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	composePriceDropNotice,
	coverKey,
	type PriceDropCopy,
	runPriceDropNotices,
} from "#/features/ops-automation/server/price-drop-notice";
import { applyMigrations } from "./migrations";

const now = Date.parse("2026-10-22T01:05:00Z");
const origin = "https://shop.example";

const copy = (sku: string): PriceDropCopy => ({
	productId: "gpt",
	title: `${sku} 标题`,
	sku,
	pitch: "卖点",
	hant: [`${sku} 繁`, "賣點"],
	en: [`${sku} EN`, "Pitch."],
	ru: [`${sku} RU`, "Пункт."],
	vi: [`${sku} VI`, "Điểm."],
	tags: "#ChatGPT",
});

describe("price-drop channel notices", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let files: R2Bucket;
	const posts: FormData[] = [];
	let reply: () => Response = () =>
		Response.json({
			ok: true,
			result: { message_id: 70, chat: { username: "laoshirenai" } },
		});
	const fetcher = (async (url: string, init?: RequestInit) => {
		if (String(url).endsWith("/sendPhoto")) {
			posts.push(init?.body as FormData);
			return reply();
		}
		return Response.json({ ok: true, result: {} });
	}) as typeof fetch;
	const run = (at = now) =>
		runPriceDropNotices({
			db,
			files,
			now: at,
			fetcher,
			botToken: "token",
			origin,
		});
	const setting = (key: string, value: unknown) =>
		db
			.prepare(
				`INSERT INTO system_settings (key, value, created_at, updated_at) VALUES (?, ?, 1, 1)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			)
			.bind(key, JSON.stringify(value))
			.run();
	const claim = async (auditId: string) =>
		JSON.parse(
			(await db
				.prepare("SELECT value FROM system_settings WHERE key = ?")
				.bind(`ops.price_drop_notice.sent.${auditId}`)
				.first<string>("value")) ?? "null",
		);

	beforeEach(async () => {
		posts.length = 0;
		reply = () =>
			Response.json({
				ok: true,
				result: { message_id: 70, chat: { username: "laoshirenai" } },
			});
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
			r2Buckets: ["FILES"],
		});
		db = await miniflare.getD1Database("DB");
		files = (await miniflare.getR2Bucket("FILES")) as unknown as R2Bucket;
		await applyMigrations(db);
		const item = (id: string, price: string) =>
			db
				.prepare(
					`INSERT INTO product_sellable_items (id, product_id, name, currency, currency_decimals, price_minor, created_at, updated_at)
					 VALUES (?, 'gpt', ?, 'CNY', 2, ?, 1, 1)`,
				)
				.bind(id, id, price);
		const audit = (
			id: string,
			itemId: string,
			before: string,
			after: string,
			at: number,
			action = "pricing_guard.auto_follow",
		) =>
			db
				.prepare(
					`INSERT INTO audit_logs (id, action, target_type, target_id, before, after, created_at)
					 VALUES (?, ?, 'sellable_item', ?, ?, ?, ?)`,
				)
				.bind(
					id,
					action,
					itemId,
					JSON.stringify({ priceMinor: before }),
					JSON.stringify({ priceMinor: after }),
					at,
				);
		await db.batch([
			db.prepare(
				`INSERT INTO products (id, name, product_type, status, created_at, updated_at)
				 VALUES ('gpt', 'ChatGPT', 'stock', 'active', 1, 1)`,
			),
			item("drop", "63800"),
			item("raise", "14800"),
			item("nocopy", "900"),
			item("moved", "70000"),
			item("approved", "50000"),
			audit("a-drop", "drop", "66000", "63800", now - 60_000),
			audit("a-raise", "raise", "13500", "14800", now - 60_000),
			audit("a-nocopy", "nocopy", "1000", "900", now - 60_000),
			// Dropped, but the price changed again since: not posted.
			audit("a-moved", "moved", "71000", "69000", now - 60_000),
			audit(
				"a-approved",
				"approved",
				"52000",
				"50000",
				now - 50_000,
				"pricing_guard.owner_raise",
			),
			// Older than the starting point: never posted.
			audit("a-old", "drop", "70000", "66000", now - 3_600_000),
		]);
		for (const id of ["drop", "raise", "moved", "approved"])
			await files.put(coverKey(id), new Uint8Array([137, 80, 78, 71]));
	});

	afterEach(async () => miniflare.dispose());

	it("posts each drop once, skips raises and stale drops, flags missing copy", async () => {
		await expect(run()).resolves.toEqual({ status: "disabled" });
		await setting("ops.price_drop_notice.enabled", true);
		await expect(run(now - 120_000)).resolves.toEqual({
			status: "initialized",
		});
		await setting("ops.price_drop_notice.chat_id", "@laoshirenai");
		await setting("ops.price_drop_notice.copy", {
			drop: copy("Pro 100"),
			raise: copy("Plus"),
			moved: copy("Pro 200"),
			approved: copy("Business"),
		});

		await expect(run()).resolves.toEqual({
			status: "ran",
			posted: 2,
			problems: 1,
		});
		expect(posts).toHaveLength(2);
		expect(posts[0]?.get("chat_id")).toBe("@laoshirenai");
		expect(String(posts[0]?.get("caption"))).toContain(
			"📉 降价通知｜Pro 100 标题",
		);
		expect(String(posts[0]?.get("caption"))).toContain(
			`🛒 ${origin}/products/gpt?item=drop`,
		);
		expect(String(posts[0]?.get("caption"))).not.toContain("¥");
		await expect(claim("a-drop")).resolves.toEqual({
			state: "sent",
			link: "https://t.me/laoshirenai/70",
		});
		await expect(claim("a-approved")).resolves.toMatchObject({
			state: "sent",
		});
		await expect(claim("a-nocopy")).resolves.toEqual({ state: "no_copy" });
		await expect(claim("a-moved")).resolves.toEqual({ state: "skipped" });
		await expect(claim("a-raise")).resolves.toBeNull();
		await expect(claim("a-old")).resolves.toBeNull();

		// The next minute finds nothing new.
		await expect(run(now + 60_000)).resolves.toMatchObject({ posted: 0 });
		expect(posts).toHaveLength(2);
	});

	it("retries a rejected post up to three times and never resends an uncertain one", async () => {
		await setting("ops.price_drop_notice.enabled", true);
		await setting("ops.price_drop_notice.since_ms", now - 120_000);
		await setting("ops.price_drop_notice.chat_id", "@laoshirenai");
		await setting("ops.price_drop_notice.copy", { drop: copy("Pro 100") });
		reply = () => Response.json({ ok: false, error_code: 400 });
		for (let attempt = 1; attempt <= 4; attempt += 1)
			await run(now + attempt * 60_000);
		// a-approved has no copy here; a-drop was tried exactly three times.
		expect(posts.filter((form) => form.get("caption"))).toHaveLength(3);
		await expect(claim("a-drop")).resolves.toEqual({
			state: "failed",
			attempts: 3,
		});

		await db
			.prepare(
				"DELETE FROM system_settings WHERE key LIKE 'ops.price_drop_notice.sent.%'",
			)
			.run();
		posts.length = 0;
		reply = () => {
			throw new Error("network");
		};
		await run(now + 10 * 60_000);
		await run(now + 11 * 60_000);
		expect(posts).toHaveLength(1);
		await expect(claim("a-drop")).resolves.toEqual({ state: "unknown" });
	});

	it("bolds the heading and each language name and folds the translations", () => {
		const { caption, entities } = composePriceDropNotice(
			origin,
			"drop",
			copy("Pro 100"),
		);
		const text = (entity: { offset: number; length: number }) =>
			caption.slice(entity.offset, entity.offset + entity.length);
		expect(entities.map(text)).toEqual([
			"📉 降价通知｜Pro 100 标题",
			expect.stringMatching(/^🌐 繁體 · English[\s\S]*Điểm\.$/),
			"Pro 100 繁",
			"Pro 100 EN",
			"Pro 100 RU",
			"Pro 100 VI",
		]);
		expect(
			caption.endsWith("🔄 代理卡网已同步 · Reseller catalog synced"),
		).toBe(true);
	});
});
