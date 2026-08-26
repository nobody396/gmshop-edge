import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	authorizeSupportAdministrator,
	supportAdministratorMirrorFreshMs,
} from "#/features/telegram/server/support-admins";
import { applyMigrations } from "./migrations";

describe("Telegram support administrator authorization", () => {
	let miniflare: Miniflare;
	let database: D1Database;
	const chatId = "-1001234567890";
	const userId = "8141269283";

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		const now = Date.now();
		await database.batch([
			database
				.prepare(
					`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
					 VALUES ('telegram.support.chat_id', ?, 0, ?, ?)`,
				)
				.bind(JSON.stringify(chatId), now, now),
			database
				.prepare(
					`INSERT INTO telegram_support_administrators
					 (support_chat_id, telegram_user_id, status, created_at, updated_at)
					 VALUES (?, ?, 'creator', ?, ?)`,
				)
				.bind(chatId, userId, now, now),
		]);
	});

	afterEach(async () => miniflare.dispose());

	it("uses a fresh administrator mirror without calling Telegram", async () => {
		const getChatMember = vi.fn();
		await expect(
			authorizeSupportAdministrator(database, { getChatMember } as never, {
				supportChatId: chatId,
				telegramUserId: userId,
				lastAdminSyncAt: Date.now(),
			}),
		).resolves.toBe(true);
		expect(getChatMember).not.toHaveBeenCalled();
	});

	it("revalidates a stale administrator mirror on the incoming reply", async () => {
		const now = Date.now();
		const getChatMember = vi.fn().mockResolvedValue({ status: "creator" });
		await expect(
			authorizeSupportAdministrator(database, { getChatMember } as never, {
				supportChatId: chatId,
				telegramUserId: userId,
				lastAdminSyncAt: now - supportAdministratorMirrorFreshMs - 1,
				now,
			}),
		).resolves.toBe(true);
		expect(getChatMember).toHaveBeenCalledWith(chatId, Number(userId));
	});

	it("rejects and removes a stale mirror when Telegram reports a normal member", async () => {
		const getChatMember = vi.fn().mockResolvedValue({ status: "member" });
		await expect(
			authorizeSupportAdministrator(database, { getChatMember } as never, {
				supportChatId: chatId,
				telegramUserId: userId,
				lastAdminSyncAt: 1,
			}),
		).resolves.toBe(false);
		await expect(
			database
				.prepare(
					`SELECT 1 AS found FROM telegram_support_administrators
					 WHERE support_chat_id = ? AND telegram_user_id = ?`,
				)
				.bind(chatId, userId)
				.first(),
		).resolves.toBeNull();
	});
});
