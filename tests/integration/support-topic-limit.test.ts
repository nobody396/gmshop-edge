import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	claimSupportTopicSlot,
	supportTopicLimits,
} from "#/features/telegram/server/support-topic-limit";
import { applyMigrations } from "./migrations";

describe("support topic creation limits", () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"));
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await miniflare.dispose();
	});

	it("allows 3 new topics per user per hour, then limits that user only", async () => {
		for (let i = 0; i < supportTopicLimits.userHour.limit; i++)
			expect(await claimSupportTopicSlot(database, "tg:1")).toEqual({
				allowed: true,
			});
		expect(await claimSupportTopicSlot(database, "tg:1")).toEqual({
			allowed: false,
			code: "support_topic_user_limited",
		});
		expect(await claimSupportTopicSlot(database, "tg:2")).toEqual({
			allowed: true,
		});
	});

	it("caps all strangers at 20 new topics per 10 minutes", async () => {
		for (let i = 0; i < supportTopicLimits.globalShort.limit; i++)
			expect((await claimSupportTopicSlot(database, `tg:${i}`)).allowed).toBe(
				true,
			);
		expect(await claimSupportTopicSlot(database, "tg:new")).toEqual({
			allowed: false,
			code: "support_topic_global_limited",
		});
	});

	it("caps new topics at 60 per hour across 10 minute windows", async () => {
		let created = 0;
		for (let window = 0; window < 6; window++) {
			vi.setSystemTime(
				new Date(Date.parse("2026-10-20T00:00:00.000Z") + window * 600_000),
			);
			for (let i = 0; i < 20; i++) {
				const result = await claimSupportTopicSlot(
					database,
					`tg:${window}-${i}`,
				);
				if (result.allowed) created++;
			}
		}
		expect(created).toBe(60);
		vi.setSystemTime(new Date("2026-10-20T00:59:00.000Z"));
		expect(await claimSupportTopicSlot(database, "tg:late")).toEqual({
			allowed: false,
			code: "support_topic_global_limited",
		});
	});

	it("does not spend global budget when the user is already limited", async () => {
		for (let i = 0; i < 3; i++) await claimSupportTopicSlot(database, "tg:1");
		for (let i = 0; i < 10; i++) await claimSupportTopicSlot(database, "tg:1");
		const row = await database
			.prepare(
				"SELECT count FROM rate_limit_counters WHERE bucket_key = 'support:topic-open:global:10m'",
			)
			.first<{ count: number }>();
		expect(row?.count).toBe(3);
	});

	it("only claims a slot after existing conversations are handled", () => {
		const source = readFileSync(
			new URL("../../src/features/telegram/server/bot.ts", import.meta.url),
			"utf8",
		);
		const claim = source.indexOf("claimSupportTopicSlot(db");
		expect(claim).toBeGreaterThan(
			source.indexOf('existing?.status === "active"'),
		);
		expect(claim).toBeGreaterThan(source.indexOf("reopenForumTopic"));
		const relay = source.indexOf("async function relayCustomerMessage");
		expect(
			relay === -1 || source.indexOf("claimSupportTopicSlot", relay) === -1,
		).toBe(true);
		const web = readFileSync(
			new URL(
				"../../src/features/telegram/server/web-support.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(web.indexOf("claimSupportTopicSlot(")).toBeGreaterThan(
			web.indexOf("reopenExisting(db"),
		);
	});

	it("tells customers politely to retry later in both languages", () => {
		const zh = JSON.parse(readFileSync("messages/zh-CN.json", "utf8"));
		const en = JSON.parse(readFileSync("messages/en-US.json", "utf8"));
		for (const key of ["telegram_support_busy", "web_support_busy"]) {
			expect(zh[key]).toBe(
				"当前咨询较多，请几分钟后再试，或直接在订单页提交问题。",
			);
			expect(en[key]).toContain("try again in a few minutes");
			expect(en[key]).toContain("order page");
		}
	});
});
