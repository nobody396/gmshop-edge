import { expect, it } from "vitest";
import { upgradeQuoteSchema } from "#/features/gpt-upgrade/schema";
import { upgradePaidResponseSchema } from "#/features/gpt-upgrade/server/client";

// Shapes exactly as laoshirenvip-redeem worker/upgrade.ts readQuote / markPaid emit them (incl. nulls).
it("accepts the redeem worker's real responses", () => {
	const quote = {
		quote_id: "6f1c2a0e-1b2c-4d3e-8f40-0a1b2c3d4e5f",
		state: "open",
		target_plan: "pro20x",
		target_label: "ChatGPT Pro 200（Pro 20x）",
		source_label: null,
		account_hint: null,
		remaining_days: null,
		price_minor: "121000",
		currency: "CNY",
		currency_decimals: 2,
		expires_at: 1800000000000,
	};
	expect(upgradeQuoteSchema.parse(quote).price_minor).toBe("121000");
	for (const state of ["queued", "processing", "completed", "review"])
		expect(
			upgradePaidResponseSchema.parse({
				success: true,
				data: {
					upgrade_id: "6f1c2a0e-1b2c-4d3e-8f40-0a1b2c3d4e5f",
					state,
					status_url: `https://redeem.laoshirenvip.com/upgrade/status/${"A".repeat(43)}`,
				},
			}).data.state,
		).toBe(state);
});
