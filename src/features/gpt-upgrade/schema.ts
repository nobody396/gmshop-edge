import { z } from "zod";

export const upgradeQuoteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const upgradeQuoteSchema = z.object({
	quote_id: z.uuid(),
	state: z.enum(["open", "paid", "expired"]),
	target_plan: z.string().min(1).max(64),
	target_label: z.string().min(1).max(200),
	source_label: z.string().min(1).max(200),
	account_hint: z.string().min(1).max(320),
	remaining_days: z.number().nonnegative(),
	price_minor: z.string().regex(/^[1-9][0-9]{0,14}$/),
	currency: z.literal("CNY"),
	currency_decimals: z.literal(2),
	expires_at: z.number().int().positive(),
});
