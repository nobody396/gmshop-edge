import { z } from "zod";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "#/features/redeem-warehouse/server/warehouse-client";
import { DomainError } from "#/lib/domain-error";
import { upgradeQuoteSchema, upgradeQuoteTokenSchema } from "../schema";

export async function loadUpgradeQuote(
	db: D1Database,
	secret: string,
	quoteToken: string,
) {
	const token = upgradeQuoteTokenSchema.parse(quoteToken);
	const result = await requestWarehouse(
		await loadDeliveryWarehouseToken(db, secret),
		"/api/internal/upgrade/quote",
		{ method: "POST", body: JSON.stringify({ quote_token: token }) },
	);
	return z
		.object({ success: z.literal(true), data: upgradeQuoteSchema })
		.parse(result).data;
}

export function assertOpenUpgradeQuote(
	quote: z.infer<typeof upgradeQuoteSchema>,
	now = Date.now(),
) {
	if (quote.state !== "open" || quote.expires_at <= now)
		throw new DomainError(
			"upgrade_quote_expired",
			409,
			"Quote is no longer available",
		);
}

export const upgradePaidResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		upgrade_id: z.uuid(),
		status_url: z
			.string()
			.regex(
				/^https:\/\/redeem\.laoshirenvip\.com\/upgrade\/status\/[A-Za-z0-9_-]+$/,
			),
		state: z.literal("queued"),
	}),
});
