import {
	parseCostFactors,
	realCostMinor,
} from "#/features/ops-automation/server/pricing-guard";
import { loadSettings } from "#/features/ops-automation/server/shared";

/** Invitation budget = 35% of the thinnest channel margin, whole yuan (owner 2026-11-07). */
export const referralMarginBps = 3_500n;
/** Never more than 10% of the list price, so a stale or wrong cost cannot run away. */
export const referralPriceCapBps = 1_000n;

type SkuRow = {
	id: string;
	price_minor: string;
	cost_minor: string | null;
	promotion_budget_minor: string;
	referral_budget_minor: string;
	currency: string;
	currency_decimals: number;
};
type ChannelRow = { id: string; fee_bps: number };
type ChannelPriceRow = {
	sellable_item_id: string;
	channel_id: string;
	price_minor: string;
};

/**
 * Whole-yuan invitation budget for one SKU. A SKU joins only when its recall
 * budget is above zero (the owner's participation list) and it has a cost.
 * Margin is the worst enabled channel: price × (1 − fee) − real cost, where real
 * cost uses the highest supplier factor because the source is not known here.
 */
export function referralBudgetFor(input: {
	priceMinor: bigint;
	costMinor: bigint | null;
	participates: boolean;
	channels: { priceMinor: bigint; feeBps: bigint }[];
	realCost: (costMinor: bigint) => bigint;
}) {
	if (!input.participates || !input.costMinor || input.costMinor <= 0n)
		return 0n;
	const real = input.realCost(input.costMinor);
	const prices = input.channels.length
		? input.channels
		: [{ priceMinor: input.priceMinor, feeBps: 0n }];
	let margin: bigint | null = null;
	for (const channel of prices) {
		const net =
			(channel.priceMinor * (10_000n - channel.feeBps)) / 10_000n - real;
		if (margin === null || net < margin) margin = net;
	}
	if (margin === null || margin <= 0n) return 0n;
	let budget = (margin * referralMarginBps) / 10_000n;
	const cap = (input.priceMinor * referralPriceCapBps) / 10_000n;
	if (budget > cap) budget = cap;
	return (budget / 100n) * 100n;
}

function parseEqualGroups(value: unknown): string[][] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(group): group is string[] =>
			Array.isArray(group) && group.every((id) => typeof id === "string"),
	);
}

/** Recompute every SKU's invitation budget and write only the rows that changed. */
export async function refreshReferralBudgets(db: D1Database) {
	const settings = await loadSettings(db, [
		"pricing.cost_factors",
		"pricing.equal_price_groups",
	]);
	const factors = parseCostFactors(settings.get("pricing.cost_factors"));
	const source = (["86", "xiaojiu", "aisou"] as const).reduce((a, b) =>
		factors[a] >= factors[b] ? a : b,
	);
	const [skus, channels, channelPrices] = await db.batch([
		db.prepare(
			`SELECT id, price_minor, cost_minor, promotion_budget_minor, referral_budget_minor,
			 currency, currency_decimals FROM product_sellable_items`,
		),
		db.prepare("SELECT id, fee_bps FROM payment_channels WHERE enabled = 1"),
		db.prepare(
			`SELECT sellable_item_id, channel_id, price_minor FROM sellable_item_channel_prices
			 WHERE enabled = 1`,
		),
	]);
	const enabledChannels = (channels?.results ?? []) as ChannelRow[];
	const overrides = new Map<string, Map<string, bigint>>();
	for (const row of (channelPrices?.results ?? []) as ChannelPriceRow[]) {
		if (!/^\d+$/.test(row.price_minor)) continue;
		const map = overrides.get(row.sellable_item_id) ?? new Map();
		map.set(row.channel_id, BigInt(row.price_minor));
		overrides.set(row.sellable_item_id, map);
	}
	const rows = (skus?.results ?? []) as SkuRow[];
	const budgets = new Map<string, bigint>();
	for (const row of rows) {
		const valid =
			row.currency === "CNY" &&
			Number(row.currency_decimals) === 2 &&
			/^\d+$/.test(row.price_minor);
		if (!valid) {
			budgets.set(row.id, 0n);
			continue;
		}
		const price = BigInt(row.price_minor);
		const cost =
			row.cost_minor && /^\d+$/.test(row.cost_minor)
				? BigInt(row.cost_minor)
				: null;
		budgets.set(
			row.id,
			referralBudgetFor({
				priceMinor: price,
				costMinor: cost,
				participates: row.promotion_budget_minor !== "0",
				channels: enabledChannels.map((channel) => ({
					priceMinor: overrides.get(row.id)?.get(channel.id) ?? price,
					feeBps: BigInt(Math.max(0, Number(channel.fee_bps) || 0)),
				})),
				realCost: (minor) =>
					BigInt(realCostMinor(Number(minor), source, factors)),
			}),
		);
	}
	// Same-price twins (Pro 200 new/renew) share the lower budget.
	for (const group of parseEqualGroups(
		settings.get("pricing.equal_price_groups"),
	)) {
		const known = group.filter((id) => budgets.has(id));
		if (known.length < 2) continue;
		const lowest = known
			.map((id) => budgets.get(id) ?? 0n)
			.reduce((a, b) => (a < b ? a : b));
		for (const id of known) budgets.set(id, lowest);
	}
	const changed = rows.filter(
		(row) =>
			(budgets.get(row.id) ?? 0n).toString() !== row.referral_budget_minor,
	);
	if (changed.length)
		await db.batch(
			changed.map((row) =>
				db
					.prepare(
						"UPDATE product_sellable_items SET referral_budget_minor = ? WHERE id = ?",
					)
					.bind((budgets.get(row.id) ?? 0n).toString(), row.id),
			),
		);
	return { status: "ok" as const, changed: changed.length };
}
