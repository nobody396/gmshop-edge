import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Telegram incremental migration", () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigration(database, "0000_gmshop.sql");
	});

	afterEach(async () => miniflare.dispose());

	it("preserves existing production data while adding support tables", async () => {
		const now = Date.now();
		await database
			.prepare(
				`INSERT INTO system_settings (key, value, created_at, updated_at)
				 VALUES ('test.existing', '"preserved"', ?, ?)`,
			)
			.bind(now, now)
			.run();
		await applyMigration(database, "0001_telegram_bot_support.sql");
		await applyMigration(database, "0002_glamorous_pete_wisdom.sql");
		await applyMigration(database, "0017_web_support_attachments.sql");
		const existing = await database
			.prepare("SELECT value FROM system_settings WHERE key = 'test.existing'")
			.first<{ value: string }>();
		expect(existing?.value).toBe('"preserved"');
		const tables = await database
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table'
				 AND name LIKE 'telegram_support_%' ORDER BY name`,
			)
			.all<{ name: string }>();
		expect(tables.results.map((row) => row.name)).toEqual([
			"telegram_support_administrators",
			"telegram_support_conversations",
		]);
		const webTables = await database
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table'
				 AND name LIKE 'telegram_web_support_%' ORDER BY name`,
			)
			.all<{ name: string }>();
		expect(webTables.results.map((row) => row.name)).toEqual([
			"telegram_web_support_attachments",
			"telegram_web_support_conversations",
			"telegram_web_support_replies",
			"telegram_web_support_sends",
		]);
		expect(
			(await database.prepare("PRAGMA foreign_key_check").all()).results,
		).toEqual([]);
	});
});

async function applyMigration(database: D1Database, name: string) {
	const sql = await readFile(
		new URL(`../../drizzle/${name}`, import.meta.url),
		"utf8",
	);
	for (const statement of sql
		.split("--> statement-breakpoint")
		.map((value) => value.trim())
		.filter(Boolean))
		await database.prepare(statement).run();
}
