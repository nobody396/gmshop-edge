import { describe, expect, it } from "vitest";
import { miniAppUrl } from "#/features/telegram/server/sync";
import { telegramSettingsInputSchema } from "#/features/telegram/settings";

describe("Telegram settings", () => {
	it("accepts only bounded support configuration", () => {
		const valid = {
			autoSyncEnabled: true,
			autoSyncIntervalMs: 60_000,
			supportEnabled: false,
			webSupportEnabled: false,
			supportChatId: "-1001234567890",
			idleTimeoutMs: 300_000,
		};
		expect(telegramSettingsInputSchema.parse(valid)).toEqual(valid);
		expect(
			telegramSettingsInputSchema.safeParse({
				...valid,
				idleTimeoutMs: 299_999,
			}).success,
		).toBe(false);
		expect(
			telegramSettingsInputSchema.safeParse({
				...valid,
				idleTimeoutMs: 30 * 86_400_000 + 1,
			}).success,
		).toBe(false);
		expect(
			telegramSettingsInputSchema.safeParse({
				...valid,
				supportChatId: "123456",
			}).success,
		).toBe(false);
	});

	it("uses fixed, campaign-tagged Mini App paths on the configured public origin", () => {
		expect(miniAppUrl("https://shop.example", "shop")).toBe(
			"https://shop.example/?utm_source=telegram&utm_medium=bot&utm_campaign=miniapp_shop",
		);
		expect(miniAppUrl("https://shop.example", "orders")).toBe(
			"https://shop.example/account/orders?utm_source=telegram&utm_medium=bot&utm_campaign=miniapp_orders",
		);
		expect(miniAppUrl("https://shop.example", "account")).toBe(
			"https://shop.example/account/settings?utm_source=telegram&utm_medium=bot&utm_campaign=miniapp_account",
		);
	});
});
