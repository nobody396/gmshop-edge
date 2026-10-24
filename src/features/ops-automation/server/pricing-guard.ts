import { z } from "zod";
import { saleComponents } from "#/features/redeem-warehouse/server/sale-capacity";
import { proposeOwnerAction } from "#/features/telegram/server/owner-actions";
import { DomainError } from "#/lib/domain-error";
import {
	beijingClock,
	claimPeriod,
	type Deliver,
	fetchProcurementPrices,
	fetchProcurementStats,
	formatYuan,
	loadSettings,
	type ProcurementPrices,
	type ProcurementStats,
	resolveDeliver,
	retryUnsent,
	sendOrPark,
	settingStatement,
} from "./shared";

export const pricingGuardSettingKeys = {
	enabled: "ops.pricing_guard.enabled",
	lastRunDay: "ops.pricing_guard.last_run_day",
	unsent: "ops.pricing_guard.unsent_message",
	costFactors: "pricing.cost_factors",
	minNetMinor: "pricing.min_net_minor",
	costBaselines: "pricing.cost_baselines",
} as const;

export const defaultCostFactors = {
	"86": 1.0042,
	xiaojiu: 1.0018,
	aisou: 0.9937,
	buffer: 1.01,
} as const;
export const defaultMinNetMinor = 300;
/** Agent supply prices below this net are flagged for review. */
export const agentMinNetMinor = 100;
export const pricingGuardHour = 9;
/** Changes at or under this share apply automatically; above it they need the owner. */
const autoChangeLimitPercent = 10;
/** Cost rises at or above this are followed; smaller ones add up first. */
const followMinRiseMinor = 100;
/** Cost drops are followed only at or above both of these. */
const followMinDropMinor = 500;
const followMinDropPercent = 3;
const alipayKeepPercent = 98;
const alipayOverUsdtPercent = 102;

type CostSource = "86" | "xiaojiu" | "aisou";
type FactorsPpm = Record<CostSource | "buffer", bigint>;

const factorSchema = z.number().min(0.5).max(2);

export function parseCostFactors(value: unknown): FactorsPpm {
	const record =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	const pick = (key: keyof typeof defaultCostFactors) => {
		const parsed = factorSchema.safeParse(record[key]);
		return BigInt(
			Math.round(
				(parsed.success ? parsed.data : defaultCostFactors[key]) * 1e6,
			),
		);
	};
	return {
		"86": pick("86"),
		xiaojiu: pick("xiaojiu"),
		aisou: pick("aisou"),
		buffer: pick("buffer"),
	};
}

/** C = supplier price × source factor × buffer, rounded up to the fen. */
export function realCostMinor(
	supplierPriceMinor: number,
	source: CostSource,
	factors: FactorsPpm,
) {
	const numerator =
		BigInt(supplierPriceMinor) * factors[source] * factors.buffer;
	const denominator = 1_000_000_000_000n;
	return Number((numerator + denominator - 1n) / denominator);
}

/** Smallest whole-yuan price ≥ minor. Prices are plain integers, no 8/9 tails. */
export function ceilYuanMinor(minor: number) {
	return Math.ceil(minor / 100) * 100;
}

/**
 * Rises of ¥1 or more are always followed. Drops are followed only once they
 * reach both ¥5 and 3% of the USDT price, so ¥150 does not turn into ¥149.
 */
export function shouldFollow(deltaMinor: number, usdtMinor: number) {
	if (deltaMinor > 0) return deltaMinor >= followMinRiseMinor;
	return (
		-deltaMinor >= followMinDropMinor &&
		-deltaMinor * 100 >= usdtMinor * followMinDropPercent
	);
}

const ceilDiv = (a: number, b: number) => Math.ceil(a / b);

export type PricePlan = {
	usdtOld: number;
	usdtNew: number;
	alipayOld: number | null;
	alipayNew: number | null;
	agentOld?: number | null;
	agentNew?: number | null;
	auto: boolean;
};

/** Minimal raise satisfying both nets ≥ floor and 支付宝 ≥ USDT × 1.02. Never lowers. */
export function planPrice(input: {
	usdtMinor: number;
	alipayMinor: number | null;
	costMinor: number;
	floorMinor: number;
}): PricePlan | null {
	const need = input.costMinor + input.floorMinor;
	const usdtLow = input.usdtMinor < need;
	const alipayLow =
		input.alipayMinor !== null &&
		input.alipayMinor * alipayKeepPercent < need * 100;
	if (!usdtLow && !alipayLow) return null;
	const usdtNew = usdtLow
		? Math.max(input.usdtMinor, ceilYuanMinor(need))
		: input.usdtMinor;
	let alipayNew: number | null = null;
	if (input.alipayMinor !== null) {
		const required = Math.max(
			ceilDiv(need * 100, alipayKeepPercent),
			ceilDiv(usdtNew * alipayOverUsdtPercent, 100),
		);
		alipayNew =
			input.alipayMinor >= required
				? input.alipayMinor
				: Math.max(input.alipayMinor, ceilYuanMinor(required));
	}
	const within = (oldMinor: number, newMinor: number) =>
		(newMinor - oldMinor) * 100 <= oldMinor * autoChangeLimitPercent;
	return {
		usdtOld: input.usdtMinor,
		usdtNew,
		alipayOld: input.alipayMinor,
		alipayNew,
		auto:
			within(input.usdtMinor, usdtNew) &&
			(input.alipayMinor === null ||
				alipayNew === null ||
				within(input.alipayMinor, alipayNew)),
	};
}

/**
 * Shifts USDT, 支付宝 and agent prices by the supplier cost change, rounded up
 * to whole yuan so no order nets less than before, then re-applies the floors.
 * Moves up and down; 支付宝 keeps its gap over USDT.
 */
export function followPlan(input: {
	usdtMinor: number;
	alipayMinor: number | null;
	agentMinor: number | null;
	costMinor: number;
	baselineMinor: number;
	floorMinor: number;
}): PricePlan | null {
	const delta = input.costMinor - input.baselineMinor;
	const need = input.costMinor + input.floorMinor;
	// A floor may stop a drop short, but never turns it into a raise.
	const settle = (oldMinor: number, required: number) => {
		const next = ceilYuanMinor(Math.max(oldMinor + delta, required));
		return delta < 0
			? Math.min(next, Math.max(oldMinor, ceilYuanMinor(required)))
			: next;
	};
	const usdtNew = settle(input.usdtMinor, need);
	const alipayNew =
		input.alipayMinor === null
			? null
			: settle(
					input.alipayMinor,
					Math.max(ceilDiv(need * 100, alipayKeepPercent), usdtNew),
				);
	let agentNew: number | null = null;
	if (input.agentMinor !== null) {
		const minimum = ceilYuanMinor(input.costMinor + agentMinNetMinor);
		agentNew = ceilYuanMinor(input.agentMinor + delta);
		// Agents must still undercut our own USDT price.
		if (agentNew >= usdtNew) agentNew = usdtNew - 100;
		agentNew = Math.max(agentNew, minimum);
	}
	if (
		usdtNew === input.usdtMinor &&
		alipayNew === input.alipayMinor &&
		agentNew === input.agentMinor
	)
		return null;
	return {
		usdtOld: input.usdtMinor,
		usdtNew,
		alipayOld: input.alipayMinor,
		alipayNew,
		agentOld: input.agentMinor,
		agentNew,
		auto: Math.abs(delta) * 100 <= input.baselineMinor * autoChangeLimitPercent,
	};
}

type ItemRow = {
	id: string;
	product_id: string;
	product_name: string;
	item_name: string;
	price_minor: string;
	version: number;
	usdt_price_id: string | null;
	alipay_price_id: string | null;
	alipay_minor: string | null;
	aisou_cost_minor: string | null;
	agent_listing_id: string | null;
	agent_price_minor: string | null;
};

export type PricingOutcome = {
	label: string;
	costMinor: number;
	/** Set when the plan follows a supplier cost change. */
	baselineMinor?: number;
	plan: PricePlan;
	applied: boolean;
	itemId?: string;
	supplierMinor?: number;
};
export type AgentWarning = {
	label: string;
	costMinor: number;
	agentMinor: number;
	suggestedMinor: number;
};

export async function runPricingGuard(input: {
	db: D1Database;
	now?: number;
	force?: boolean;
	fetcher?: typeof fetch;
	deliver?: Deliver;
	readStats?: () => Promise<ProcurementStats | null>;
	readPrices?: () => Promise<ProcurementPrices | null>;
}) {
	const now = input.now ?? Date.now();
	const fetcher = input.fetcher ?? fetch;
	const settings = await loadSettings(
		input.db,
		Object.values(pricingGuardSettingKeys),
	);
	if (!input.force && settings.get(pricingGuardSettingKeys.enabled) !== true)
		return { status: "disabled" as const };
	const deliver = resolveDeliver(
		input.db,
		fetcher,
		input.deliver,
		"ops-pricing",
		now,
		"restock",
	);
	const retried = await retryUnsent(
		input.db,
		pricingGuardSettingKeys.unsent,
		deliver,
		now,
		settings.get(pricingGuardSettingKeys.unsent),
	);
	const clock = beijingClock(now);
	if (!input.force && clock.hour < pricingGuardHour)
		return { status: "waiting" as const, retried };
	if (
		!(await claimPeriod(
			input.db,
			pricingGuardSettingKeys.lastRunDay,
			clock.day,
			now,
		)) &&
		!input.force
	)
		return { status: "done" as const, retried };

	const baselines = parseBaselines(
		settings.get(pricingGuardSettingKeys.costBaselines),
	);
	const factors = parseCostFactors(
		settings.get(pricingGuardSettingKeys.costFactors),
	);
	const floorSetting = z
		.number()
		.int()
		.nonnegative()
		.safeParse(settings.get(pricingGuardSettingKeys.minNetMinor));
	const floorMinor = floorSetting.success
		? floorSetting.data
		: defaultMinNetMinor;
	const [map, rows] = await Promise.all([
		saleComponents(input.db).catch(() => ({}) as Record<string, string>),
		loadItems(input.db),
	]);
	const needsRedeem = rows.some((row) => map[row.id]);
	const [stats, prices] = needsRedeem
		? await Promise.all([
				(
					input.readStats ?? (() => fetchProcurementStats(input.db, fetcher))
				)().catch(() => null),
				(
					input.readPrices ?? (() => fetchProcurementPrices(input.db, fetcher))
				)().catch(() => null),
			])
		: [null, null];

	const outcomes: PricingOutcome[] = [];
	const agentWarnings: AgentWarning[] = [];
	let skipped = 0;
	for (const row of rows) {
		const supplier = supplierCost(row, map, stats, prices, factors);
		if (supplier === null) {
			skipped += 1;
			continue;
		}
		const cost = supplier.costMinor;
		const label = `${row.product_name} · ${row.item_name}`;
		const baseline = baselines[row.id];
		baselines[row.id] = cost;
		if (
			baseline !== undefined &&
			shouldFollow(cost - baseline, Number(row.price_minor))
		) {
			const plan = followPlan({
				usdtMinor: Number(row.price_minor),
				alipayMinor:
					row.alipay_minor === null ? null : Number(row.alipay_minor),
				agentMinor:
					row.agent_price_minor === null ? null : Number(row.agent_price_minor),
				costMinor: cost,
				baselineMinor: baseline,
				floorMinor,
			});
			if (!plan) continue;
			const applied = plan.auto
				? await applyPlan(input.db, row, plan, {
						costMinor: cost,
						floorMinor,
						supplierMinor: supplier.supplierMinor,
						now,
						action: "pricing_guard.auto_follow",
					})
				: false;
			outcomes.push({
				label,
				costMinor: cost,
				baselineMinor: baseline,
				plan,
				applied,
				itemId: row.id,
				supplierMinor: supplier.supplierMinor,
			});
			continue;
		}
		// Small moves keep the old baseline so they can add up.
		if (baseline !== undefined) baselines[row.id] = baseline;
		if (row.agent_price_minor !== null) {
			const agentMinor = Number(row.agent_price_minor);
			if (agentMinor - cost < agentMinNetMinor)
				agentWarnings.push({
					label,
					costMinor: cost,
					agentMinor,
					suggestedMinor: ceilDiv(cost + agentMinNetMinor, 100) * 100,
				});
		}
		const plan = planPrice({
			usdtMinor: Number(row.price_minor),
			alipayMinor: row.alipay_minor === null ? null : Number(row.alipay_minor),
			costMinor: cost,
			floorMinor,
		});
		if (!plan) continue;
		const applied = plan.auto
			? await applyPlan(input.db, row, plan, {
					costMinor: cost,
					floorMinor,
					now,
				})
			: false;
		outcomes.push({ label, costMinor: cost, plan, applied, itemId: row.id });
	}
	// Proposals also move the baseline, so an ignored button is not re-sent daily.
	await settingStatement(
		input.db,
		pricingGuardSettingKeys.costBaselines,
		baselines,
		now,
	).run();

	const text = formatPricingReport(
		clock.day,
		outcomes,
		agentWarnings,
		floorMinor,
	);
	const delivery = text
		? await sendOrPark(
				input.db,
				pricingGuardSettingKeys.unsent,
				text,
				deliver,
				now,
			)
		: ("nothing" as const);
	// The report lists every proposal; each also gets its own approve button.
	let buttons = 0;
	for (const outcome of outcomes) {
		if (outcome.applied || !outcome.itemId) continue;
		const row = rows.find((item) => item.id === outcome.itemId);
		if (!row) continue;
		const proposal = await proposeOwnerAction(input.db, {
			kind: "pricing_raise",
			payload: {
				itemId: row.id,
				version: row.version,
				priceMinor: row.price_minor,
				alipayMinor: row.alipay_minor,
				costMinor: outcome.costMinor,
				floorMinor,
				supplierMinor: outcome.supplierMinor,
				agentMinor: row.agent_price_minor,
				plan: outcome.plan,
			} satisfies PricingRaisePayload,
			text: `${outcome.baselineMinor !== undefined && outcome.costMinor < outcome.baselineMinor ? "📉" : "📈"} 改价确认：${outcome.label}\n${costLine(outcome)}（净利底线 ${formatYuan(floorMinor)}）\n建议 ${priceChange(outcome.plan, true)}\n${netLine(outcome)}`,
			choices: ["✅ 按建议改价"],
			rejectLabel: "❌ 不改",
			fallback: null,
			now,
			fetcher,
		}).catch(() => null);
		if (proposal) buttons += 1;
	}
	return {
		status: "ran" as const,
		retried,
		delivery,
		buttons,
		applied: outcomes.filter((outcome) => outcome.applied).length,
		proposed: outcomes.filter((outcome) => !outcome.applied).length,
		agentWarnings: agentWarnings.length,
		skipped,
	};
}

function supplierCost(
	row: ItemRow,
	map: Record<string, string>,
	stats: ProcurementStats | null,
	prices: ProcurementPrices | null,
	factors: FactorsPpm,
) {
	const sku = map[row.id];
	if (sku) {
		const source = stats?.skus[sku]?.restockSource;
		if (!source || !prices) return null;
		const price = prices.find(
			(entry) => entry.sku === sku && entry.source === source,
		)?.priceMinor;
		return price == null
			? null
			: {
					supplierMinor: price,
					costMinor: realCostMinor(price, source, factors),
				};
	}
	if (row.aisou_cost_minor === null) return null;
	const price = Number(row.aisou_cost_minor);
	return {
		supplierMinor: price,
		costMinor: realCostMinor(price, "aisou", factors),
	};
}

const baselinesSchema = z.record(z.string(), z.number().int().nonnegative());

function parseBaselines(value: unknown): Record<string, number> {
	const parsed = baselinesSchema.safeParse(value);
	return parsed.success ? { ...parsed.data } : {};
}

const planSchema = z.object({
	usdtOld: z.number().int(),
	usdtNew: z.number().int().positive(),
	alipayOld: z.number().int().nullable(),
	alipayNew: z.number().int().positive().nullable(),
	agentOld: z.number().int().nullable().optional(),
	agentNew: z.number().int().positive().nullable().optional(),
	auto: z.boolean(),
});
const pricingRaisePayloadSchema = z.object({
	itemId: z.string(),
	version: z.number().int(),
	priceMinor: z.string(),
	alipayMinor: z.string().nullable(),
	costMinor: z.number().int().nonnegative(),
	floorMinor: z.number().int().nonnegative(),
	supplierMinor: z.number().int().nonnegative().optional(),
	agentMinor: z.string().nullable().optional(),
	plan: planSchema,
});
type PricingRaisePayload = z.infer<typeof pricingRaisePayloadSchema>;

/** Applies the proposed raise only if nobody changed the price since. */
export async function approvePricingRaise(
	context: { db: D1Database; now: number },
	rawPayload: unknown,
) {
	const payload = pricingRaisePayloadSchema.parse(rawPayload);
	const row = (await loadItems(context.db, payload.itemId))[0];
	if (
		!row ||
		row.version !== payload.version ||
		row.price_minor !== payload.priceMinor ||
		row.alipay_minor !== payload.alipayMinor ||
		(payload.agentMinor !== undefined &&
			row.agent_price_minor !== payload.agentMinor)
	)
		throw new DomainError(
			"pricing_raise_stale",
			409,
			"价格已经被改过或规格已下架",
		);
	const applied = await applyPlan(context.db, row, payload.plan, {
		costMinor: payload.costMinor,
		floorMinor: payload.floorMinor,
		supplierMinor: payload.supplierMinor,
		now: context.now,
		action: "pricing_guard.owner_raise",
	});
	if (!applied)
		throw new DomainError("pricing_raise_stale", 409, "价格刚被改过");
	return `✅ 已改价：${priceChange(payload.plan, false)}`;
}

async function loadItems(db: D1Database, onlyItemId?: string) {
	const rows = await db
		.prepare(
			`SELECT item.id, item.product_id, product.name AS product_name,
			  item.name AS item_name, item.price_minor, item.version,
			  (SELECT price.id FROM sellable_item_channel_prices price
			   JOIN payment_channels channel ON channel.id = price.channel_id
			   WHERE price.sellable_item_id = item.id AND price.enabled = 1
			    AND channel.name = 'USDT' LIMIT 1) AS usdt_price_id,
			  (SELECT price.id FROM sellable_item_channel_prices price
			   JOIN payment_channels channel ON channel.id = price.channel_id
			   WHERE price.sellable_item_id = item.id AND price.enabled = 1
			    AND channel.name = '支付宝' LIMIT 1) AS alipay_price_id,
			  (SELECT price.price_minor FROM sellable_item_channel_prices price
			   JOIN payment_channels channel ON channel.id = price.channel_id
			   WHERE price.sellable_item_id = item.id AND price.enabled = 1
			    AND channel.name = '支付宝' LIMIT 1) AS alipay_minor,
			  (SELECT binding.reference_cost_minor FROM supplier_bindings binding
			   WHERE binding.sellable_item_id = item.id AND binding.enabled = 1
			    AND binding.provider = 'shared_stock'
			    AND binding.normalized_api_origin = 'https://aisou.pro'
			   ORDER BY binding.updated_at DESC LIMIT 1) AS aisou_cost_minor,
			  (SELECT listing.id FROM supplier_export_listings listing
			   WHERE listing.sellable_item_id = item.id AND listing.enabled = 1
			    AND listing.currency = 'CNY' AND listing.currency_decimals = 2
			   LIMIT 1) AS agent_listing_id,
			  (SELECT listing.price_minor FROM supplier_export_listings listing
			   WHERE listing.sellable_item_id = item.id AND listing.enabled = 1
			    AND listing.currency = 'CNY' AND listing.currency_decimals = 2
			   LIMIT 1) AS agent_price_minor
			 FROM product_sellable_items item
			 JOIN products product ON product.id = item.product_id
			 WHERE item.enabled = 1 AND item.sale_disabled = 0
			  AND (? IS NULL OR item.id = ?)
			  AND product.status = 'active' AND product.sale_disabled = 0
			  AND item.currency = 'CNY' AND item.currency_decimals = 2
			 ORDER BY product.sort_order, item.sort_order, item.id`,
		)
		.bind(onlyItemId ?? null, onlyItemId ?? null)
		.all<ItemRow>();
	return rows.results;
}

async function applyPlan(
	db: D1Database,
	row: ItemRow,
	plan: PricePlan,
	context: {
		costMinor: number;
		floorMinor: number;
		/** Supplier list price, recorded as the item cost when known. */
		supplierMinor?: number;
		now: number;
		action?: string;
	},
) {
	const { now } = context;
	const usdt = String(plan.usdtNew);
	// Every follow-up statement is guarded on the item update having landed.
	const landed = `EXISTS (SELECT 1 FROM product_sellable_items WHERE id = ? AND version = ? AND price_minor = ?)`;
	const landedArgs = [row.id, row.version + 1, usdt] as const;
	const statements = [
		db
			.prepare(
				`UPDATE product_sellable_items SET price_minor = ?, version = version + 1,
				 cost_minor = COALESCE(?, cost_minor), updated_at = ?
				 WHERE id = ? AND version = ? AND price_minor = ?`,
			)
			.bind(
				usdt,
				context.supplierMinor === undefined
					? null
					: String(context.supplierMinor),
				now,
				row.id,
				row.version,
				row.price_minor,
			),
	];
	if (row.usdt_price_id)
		statements.push(
			db
				.prepare(
					`UPDATE sellable_item_channel_prices SET price_minor = ?, updated_at = ?
					 WHERE id = ? AND ${landed}`,
				)
				.bind(usdt, now, row.usdt_price_id, ...landedArgs),
		);
	if (row.alipay_price_id && plan.alipayNew != null)
		statements.push(
			db
				.prepare(
					`UPDATE sellable_item_channel_prices SET price_minor = ?, updated_at = ?
					 WHERE id = ? AND ${landed}`,
				)
				.bind(String(plan.alipayNew), now, row.alipay_price_id, ...landedArgs),
		);
	// Bumping the listing's updated_at makes lsrai.shop pick the price up.
	if (row.agent_listing_id && plan.agentNew != null && plan.agentOld != null)
		statements.push(
			db
				.prepare(
					`UPDATE supplier_export_listings SET price_minor = ?, updated_at = ?
					 WHERE id = ? AND price_minor = ? AND ${landed}`,
				)
				.bind(
					String(plan.agentNew),
					now,
					row.agent_listing_id,
					String(plan.agentOld),
					...landedArgs,
				),
		);
	statements.push(
		db
			.prepare(
				`UPDATE products SET revision = revision + 1, revision_token = ?, updated_at = ?
				 WHERE id = ? AND ${landed}`,
			)
			.bind(crypto.randomUUID(), now, row.product_id, ...landedArgs),
		db
			.prepare(
				`INSERT INTO audit_logs (id, action, target_type, target_id, before, after, created_at)
				 SELECT ?, ?, 'sellable_item', ?, ?, ?, ? WHERE ${landed}`,
			)
			.bind(
				crypto.randomUUID(),
				context.action ?? "pricing_guard.auto_raise",
				row.id,
				JSON.stringify({
					priceMinor: row.price_minor,
					alipayMinor: row.alipay_minor,
					agentMinor: row.agent_price_minor,
					version: row.version,
				}),
				JSON.stringify({
					priceMinor: usdt,
					alipayMinor: plan.alipayNew == null ? null : String(plan.alipayNew),
					agentMinor: plan.agentNew == null ? null : String(plan.agentNew),
					version: row.version + 1,
					costMinor: String(context.costMinor),
					minNetMinor: String(context.floorMinor),
				}),
				now,
				...landedArgs,
			),
	);
	const [result] = await db.batch(statements);
	return Number(result?.meta.changes ?? 0) === 1;
}

function percent(oldMinor: number, newMinor: number) {
	const tenths = Math.ceil((Math.abs(newMinor - oldMinor) * 1000) / oldMinor);
	return `${newMinor < oldMinor ? "-" : "+"}${(tenths / 10).toFixed(1)}%`;
}

function costLine(outcome: PricingOutcome) {
	return outcome.baselineMinor === undefined
		? `成本 ${formatYuan(outcome.costMinor)}`
		: `成本 ${formatYuan(outcome.baselineMinor)}→${formatYuan(outcome.costMinor)}`;
}

/** USDT net per order before and after, so a bad proposal is obvious at a glance. */
function netLine(outcome: PricingOutcome) {
	const before =
		outcome.plan.usdtOld - (outcome.baselineMinor ?? outcome.costMinor);
	const after = outcome.plan.usdtNew - outcome.costMinor;
	return `USDT 每单净赚 ${formatYuan(before)}→${formatYuan(after)}`;
}

function priceChange(plan: PricePlan, withPercent: boolean) {
	const part = (name: string, oldMinor: number, newMinor: number) =>
		oldMinor === newMinor
			? `${name} ${formatYuan(oldMinor)}（不变）`
			: `${name} ${formatYuan(oldMinor)}→${formatYuan(newMinor)}${withPercent ? `（${percent(oldMinor, newMinor)}）` : ""}`;
	return [
		part("USDT", plan.usdtOld, plan.usdtNew),
		plan.alipayOld !== null && plan.alipayNew !== null
			? part("支付宝", plan.alipayOld, plan.alipayNew)
			: null,
		plan.agentOld != null && plan.agentNew != null
			? part("代理", plan.agentOld, plan.agentNew)
			: null,
	]
		.filter(Boolean)
		.join("，");
}

export function formatPricingReport(
	day: string,
	outcomes: PricingOutcome[],
	agentWarnings: AgentWarning[],
	floorMinor: number,
) {
	const applied = outcomes.filter((outcome) => outcome.applied);
	const proposed = outcomes.filter((outcome) => !outcome.applied);
	if (!applied.length && !proposed.length && !agentWarnings.length) return null;
	const lines = [`📈 定价守护｜${day}（净利底线 ${formatYuan(floorMinor)}）`];
	if (applied.length)
		lines.push(
			"",
			"自动调价（事后通知）：",
			...applied.map(
				(outcome) =>
					`· ${outcome.label}：${costLine(outcome)}；${priceChange(outcome.plan, false)}`,
			),
		);
	if (proposed.length)
		lines.push(
			"",
			"需要你确认（未改价）：",
			...proposed.map(
				(outcome) =>
					`· ${outcome.label}：${costLine(outcome)}；建议 ${priceChange(outcome.plan, true)}${
						outcome.plan.auto ? "（自动调价未成功，可能刚被改过）" : ""
					}`,
			),
		);
	if (agentWarnings.length)
		lines.push(
			"",
			"代理价需要调整（仅建议，未改动）：",
			...agentWarnings.map(
				(warning) =>
					`· ${warning.label}：代理价 ${formatYuan(warning.agentMinor)}，成本 ${formatYuan(warning.costMinor)}，净利 ${formatYuan(warning.agentMinor - warning.costMinor)}；建议至少 ${formatYuan(warning.suggestedMinor)}`,
			),
		);
	return lines.join("\n");
}
