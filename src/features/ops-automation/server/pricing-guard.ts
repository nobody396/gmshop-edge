import { z } from "zod";
import { gptUpgradeProduct } from "#/features/gpt-upgrade/products";
import { saleComponents } from "#/features/redeem-warehouse/server/sale-capacity";
import { proposeOwnerAction } from "#/features/telegram/server/owner-actions";
import { DomainError } from "#/lib/domain-error";
import {
	formatRestockResumeLines,
	restockResumeSettingKey,
	resumeRestockedItems,
} from "./restock-resume";
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
	/** One-shot: run on the next tick regardless of hour or day, then clear. */
	runNow: "ops.pricing_guard.run_now",
	lastRunDay: "ops.pricing_guard.last_run_day",
	unsent: "ops.pricing_guard.unsent_message",
	costFactors: "pricing.cost_factors",
	minNetMinor: "pricing.min_net_minor",
	costBaselines: "pricing.cost_baselines",
	agentMarginBps: "pricing.agent_margin_bps",
	agentMinNetMinor: "pricing.agent_min_net_minor",
	retailMarginBps: "pricing.retail_margin_bps",
	retailMarginFromMinor: "pricing.retail_margin_from_minor",
	floorExemptItems: "pricing.floor_exempt_items",
	equalPriceGroups: "pricing.equal_price_groups",
	linkedItems: "pricing.linked_items",
	restockResumeItems: restockResumeSettingKey,
} as const;

export const defaultCostFactors = {
	"86": 1.0042,
	xiaojiu: 1.0018,
	aisou: 0.9937,
	buffer: 1.01,
} as const;
export const defaultMinNetMinor = 300;
/** Agent supply prices below this net are flagged for review (floor-exempt items). */
export const agentMinNetMinor = 100;

/**
 * Owner 2026-11-06 floors on the real cost C (supplier price × measured factor × buffer):
 * agent ≥ max(C × 1.03, C + ¥3); USDT ≥ C + min net and one grid step above the agent
 * price (pricing.retail_margin_bps can add a C × (1 + bps) retail floor; off by default);
 * 支付宝 ≥ USDT × 1.02. Items listed in pricing.floor_exempt_items keep the old
 * C + ¥1 agent floor and C + min net retail floor.
 */
export const defaultFloorRules = {
	agentMarginBps: 300,
	agentMinNetMinor: 300,
	retailMarginBps: 0,
	retailMarginFromMinor: 30_000,
} as const;
export type FloorRules = {
	agentMarginBps: number;
	agentMinNetMinor: number;
	retailMarginBps: number;
	retailMarginFromMinor: number;
	exempt: ReadonlySet<string>;
};

export function parseFloorRules(settings: Map<string, unknown>): FloorRules {
	const int = (key: keyof typeof defaultFloorRules, settingKey: string) => {
		const parsed = z
			.number()
			.int()
			.min(0)
			.max(100_000_000)
			.safeParse(settings.get(settingKey));
		return parsed.success ? parsed.data : defaultFloorRules[key];
	};
	const exempt = z
		.array(z.string())
		.safeParse(settings.get(pricingGuardSettingKeys.floorExemptItems));
	return {
		agentMarginBps: int(
			"agentMarginBps",
			pricingGuardSettingKeys.agentMarginBps,
		),
		agentMinNetMinor: int(
			"agentMinNetMinor",
			pricingGuardSettingKeys.agentMinNetMinor,
		),
		retailMarginBps: int(
			"retailMarginBps",
			pricingGuardSettingKeys.retailMarginBps,
		),
		retailMarginFromMinor: int(
			"retailMarginFromMinor",
			pricingGuardSettingKeys.retailMarginFromMinor,
		),
		exempt: new Set(exempt.success ? exempt.data : []),
	};
}

const withBps = (minor: number, bps: number) =>
	Math.ceil((minor * (10_000 + bps)) / 10_000);

/** Lowest USDT net-of-cost price allowed, before snapping to the grid. */
export function retailNeedMinor(
	costMinor: number,
	floorMinor: number,
	rules: FloorRules,
) {
	const flat = costMinor + floorMinor;
	return costMinor >= rules.retailMarginFromMinor
		? Math.max(flat, withBps(costMinor, rules.retailMarginBps))
		: flat;
}

/** Lowest agent supply price allowed, before snapping to the grid. */
export function agentFloorMinor(costMinor: number, rules: FloorRules) {
	return Math.max(
		costMinor + rules.agentMinNetMinor,
		withBps(costMinor, rules.agentMarginBps),
	);
}
export const pricingGuardHour = 9;
/** Cost rises at or above this are followed; smaller ones add up first. */
const followMinRiseMinor = 100;
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

/** Smallest whole-yuan price ≥ minor. */
export function ceilYuanMinor(minor: number) {
	return Math.ceil(minor / 100) * 100;
}

/**
 * Price grid by size: whole yuan under ¥100, ¥5 steps under ¥500, ¥10 steps
 * from ¥500, so followed prices read 115 / 355 / 1070 instead of 117 / 351 / 1068.
 */
export function niceStepMinor(minor: number) {
	if (minor < 10_000) return 100;
	if (minor < 50_000) return 500;
	return 1_000;
}

/** Smallest grid price ≥ minor. */
export function ceilNiceMinor(minor: number) {
	const step = niceStepMinor(minor);
	return Math.ceil(minor / step) * step;
}

/** Nearest grid price; halves round up. */
export function roundNiceMinor(minor: number) {
	const step = niceStepMinor(minor);
	return Math.floor(minor / step + 0.5) * step;
}

/**
 * Rises of ¥1 or more are followed; smaller ones add up first. Every drop is
 * followed — the grid decides whether it is big enough to move the price.
 */
export function shouldFollow(deltaMinor: number) {
	return deltaMinor < 0 || deltaMinor >= followMinRiseMinor;
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

/**
 * Minimal raise satisfying the floors: USDT ≥ need, 支付宝 nets ≥ need and
 * ≥ USDT × 1.02, and — when an agent floor is given — agent ≥ that floor and
 * one grid step under USDT. Never lowers.
 */
export function planPrice(input: {
	usdtMinor: number;
	alipayMinor: number | null;
	costMinor: number;
	floorMinor: number;
	/** Overrides cost + floor (e.g. the C × 1.06 retail floor). */
	needMinor?: number;
	agentMinor?: number | null;
	agentFloorMinor?: number;
}): PricePlan | null {
	const agentTracked =
		input.agentMinor != null && input.agentFloorMinor !== undefined;
	const agentNew = agentTracked
		? Math.max(
				input.agentMinor as number,
				(input.agentMinor as number) >= (input.agentFloorMinor as number)
					? (input.agentMinor as number)
					: ceilNiceMinor(input.agentFloorMinor as number),
			)
		: null;
	let need = input.needMinor ?? input.costMinor + input.floorMinor;
	// Agents must undercut our own USDT price by at least one grid step.
	if (agentNew !== null)
		need = Math.max(need, agentNew + niceStepMinor(agentNew));
	const usdtLow = input.usdtMinor < need;
	const alipayLow =
		input.alipayMinor !== null &&
		input.alipayMinor * alipayKeepPercent < need * 100;
	const agentLow = agentNew !== null && agentNew !== input.agentMinor;
	if (!usdtLow && !alipayLow && !agentLow) return null;
	const usdtNew = usdtLow
		? Math.max(input.usdtMinor, ceilNiceMinor(need))
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
				: Math.max(input.alipayMinor, ceilNiceMinor(required));
	}
	// Owner 2026-10-31: every price change applies on its own.
	return {
		usdtOld: input.usdtMinor,
		usdtNew,
		alipayOld: input.alipayMinor,
		alipayNew,
		...(agentTracked ? { agentOld: input.agentMinor, agentNew } : {}),
		auto: true,
	};
}

/**
 * Shifts USDT, 支付宝 and agent prices by the supplier cost change and snaps
 * each to the nearest grid price, then re-applies the floors. 支付宝 also never
 * ends above the new USDT price plus its old gap (owner 2026-11-02: ¥119/¥125
 * snapped on their own to ¥115/¥125). A drop never
 * becomes a raise and a rise never becomes a cut. Every change applies on
 * its own; only rises are reported to the owner.
 */
export function followPlan(input: {
	usdtMinor: number;
	alipayMinor: number | null;
	agentMinor: number | null;
	costMinor: number;
	baselineMinor: number;
	floorMinor: number;
	/** Overrides cost + floor (e.g. the C × 1.06 retail floor). */
	needMinor?: number;
	/** Overrides the C + ¥1 agent floor. */
	agentFloorMinor?: number;
}): PricePlan | null {
	const delta = input.costMinor - input.baselineMinor;
	let need = input.needMinor ?? input.costMinor + input.floorMinor;
	// With the 2026-11-06 floors, USDT also stays a grid step above the agent floor.
	if (input.agentMinor !== null && input.agentFloorMinor !== undefined) {
		const agentFloor = ceilNiceMinor(input.agentFloorMinor);
		need = Math.max(need, agentFloor + niceStepMinor(agentFloor));
	}
	const settle = (oldMinor: number, targetMinor: number, required: number) => {
		const moved = roundNiceMinor(targetMinor);
		const next =
			delta < 0 ? Math.min(moved, oldMinor) : Math.max(moved, oldMinor);
		// A floor may stop a drop short, but never turns it into a raise.
		if (next >= required) return next;
		const floor = ceilNiceMinor(required);
		return delta < 0 ? Math.min(Math.max(oldMinor, next), floor) : floor;
	};
	const usdtNew = settle(input.usdtMinor, input.usdtMinor + delta, need);
	const alipayNew =
		input.alipayMinor === null
			? null
			: settle(
					input.alipayMinor,
					Math.min(
						input.alipayMinor + delta,
						usdtNew + (input.alipayMinor - input.usdtMinor),
					),
					Math.max(ceilDiv(need * 100, alipayKeepPercent), usdtNew),
				);
	let agentNew: number | null = null;
	if (input.agentMinor !== null) {
		const minimum =
			input.agentFloorMinor === undefined
				? ceilYuanMinor(input.costMinor + agentMinNetMinor)
				: input.agentFloorMinor;
		agentNew = settle(input.agentMinor, input.agentMinor + delta, minimum);
		// Agents must still undercut our own USDT price.
		if (agentNew >= usdtNew)
			agentNew = Math.max(usdtNew - niceStepMinor(usdtNew), minimum);
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
		auto: true,
	};
}

type GroupMember = {
	id: string;
	usdtMinor: number;
	alipayMinor: number | null;
	agentMinor: number | null;
};

/**
 * Owner 2026-11-06: items in one group (Pro 200 菲区新开/续费) always sell at
 * the same USDT, 支付宝 and agent price; when they differ the higher one wins.
 * Returns a raise plan for every member below the group's highest prices.
 */
export function equalizeGroup(members: GroupMember[]) {
	const max = (values: (number | null)[]) => {
		const present = values.filter((value): value is number => value !== null);
		return present.length ? Math.max(...present) : null;
	};
	const usdt = Math.max(...members.map((member) => member.usdtMinor));
	const alipay = max(members.map((member) => member.alipayMinor));
	const agent = max(members.map((member) => member.agentMinor));
	const plans = new Map<string, PricePlan>();
	for (const member of members) {
		const alipayNew =
			member.alipayMinor === null ? null : (alipay ?? member.alipayMinor);
		const agentNew =
			member.agentMinor === null ? null : (agent ?? member.agentMinor);
		if (
			member.usdtMinor === usdt &&
			alipayNew === member.alipayMinor &&
			agentNew === member.agentMinor
		)
			continue;
		plans.set(member.id, {
			usdtOld: member.usdtMinor,
			usdtNew: usdt,
			alipayOld: member.alipayMinor,
			alipayNew,
			agentOld: member.agentMinor,
			agentNew,
			auto: true,
		});
	}
	return plans;
}

const groupsSchema = z.array(z.array(z.string()).min(2));

const linkedItemsSchema = z.array(
	z.object({
		item: z.string().min(1),
		base: z.string().min(1),
		priceOffsetMinor: z.number().int(),
		costOffsetMinor: z.number().int(),
	}),
);

export type LinkedItemPrices = {
	usdtMinor: number;
	alipayMinor: number | null;
	agentMinor: number | null;
	costMinor: number;
};

/**
 * Owner 2026-11-11: some items are priced as another item plus a fixed amount
 * (Gemini Ultra own-account = ready-made account + ¥100, cost + ¥60). Every
 * price follows the base both ways; null when nothing would change.
 */
export function linkedItemPlan(
	item: LinkedItemPrices,
	base: LinkedItemPrices,
	offsets: { priceOffsetMinor: number; costOffsetMinor: number },
) {
	const usdtNew = base.usdtMinor + offsets.priceOffsetMinor;
	const alipayNew =
		item.alipayMinor === null || base.alipayMinor === null
			? item.alipayMinor
			: base.alipayMinor + offsets.priceOffsetMinor;
	const agentNew =
		item.agentMinor === null || base.agentMinor === null
			? item.agentMinor
			: base.agentMinor + offsets.priceOffsetMinor;
	const costNew = base.costMinor + offsets.costOffsetMinor;
	if (
		usdtNew === item.usdtMinor &&
		alipayNew === item.alipayMinor &&
		agentNew === item.agentMinor &&
		costNew === item.costMinor
	)
		return null;
	return {
		plan: {
			usdtOld: item.usdtMinor,
			usdtNew,
			alipayOld: item.alipayMinor,
			alipayNew,
			agentOld: item.agentMinor,
			agentNew,
			auto: true,
		} satisfies PricePlan,
		costNew,
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
	cost_minor: string | null;
	bound_cost_minor: string | null;
	bound_origin: string | null;
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
	const runNow = settings.get(pricingGuardSettingKeys.runNow) === true;
	if (runNow) {
		const cleared = await input.db
			.prepare(
				"UPDATE system_settings SET value = 'false', updated_at = ? WHERE key = ? AND value = 'true'",
			)
			.bind(now, pricingGuardSettingKeys.runNow)
			.run();
		// Another tick already claimed the one-shot run.
		if (Number(cleared.meta.changes ?? 0) !== 1 && !input.force)
			return { status: "done" as const, retried };
	}
	if (!input.force && !runNow && clock.hour < pricingGuardHour)
		return { status: "waiting" as const, retried };
	if (
		!(await claimPeriod(
			input.db,
			pricingGuardSettingKeys.lastRunDay,
			clock.day,
			now,
		)) &&
		!input.force &&
		!runNow
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
	const rules = parseFloorRules(settings);
	const [map, rows] = await Promise.all([
		saleComponents(input.db).catch(() => ({}) as Record<string, string>),
		loadItems(input.db),
	]);
	const resumeListed = Array.isArray(
		settings.get(pricingGuardSettingKeys.restockResumeItems),
	)
		? (settings.get(pricingGuardSettingKeys.restockResumeItems) as unknown[])
				.length > 0
		: false;
	const needsRedeem = resumeListed || rows.some((row) => map[row.id]);
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

	// Specs paused for a sold-out supplier come back once it lists stock again.
	const resumed = await resumeRestockedItems(input.db, {
		value: settings.get(pricingGuardSettingKeys.restockResumeItems),
		map,
		prices,
		now,
	}).catch(() => []);

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
		const exempt = rules.exempt.has(row.id);
		const needMinor = exempt
			? undefined
			: retailNeedMinor(cost, floorMinor, rules);
		const agentFloor = exempt ? undefined : agentFloorMinor(cost, rules);
		const baseline = baselines[row.id];
		baselines[row.id] = cost;
		if (baseline !== undefined && shouldFollow(cost - baseline)) {
			const plan = followPlan({
				usdtMinor: Number(row.price_minor),
				alipayMinor:
					row.alipay_minor === null ? null : Number(row.alipay_minor),
				agentMinor:
					row.agent_price_minor === null ? null : Number(row.agent_price_minor),
				costMinor: cost,
				baselineMinor: baseline,
				floorMinor,
				needMinor,
				agentFloorMinor: agentFloor,
			});
			// Too small to move any price: keep the old baseline so drops add up,
			// and still check the floors below (2026-11-06: a tiny cost drop used
			// to skip them, leaving agent prices under the new floor).
			if (plan) {
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
		}
		// Small moves keep the old baseline so they can add up.
		if (baseline !== undefined) baselines[row.id] = baseline;
		if (exempt && row.agent_price_minor !== null) {
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
			needMinor,
			...(agentFloor === undefined
				? {}
				: {
						agentMinor:
							row.agent_price_minor === null
								? null
								: Number(row.agent_price_minor),
						agentFloorMinor: agentFloor,
					}),
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
	// Same-price groups last, on the prices as they stand after today's moves.
	const groups = groupsSchema.safeParse(
		settings.get(pricingGuardSettingKeys.equalPriceGroups),
	);
	for (const group of groups.success ? groups.data : []) {
		const members = (
			await Promise.all(group.map((id) => loadItems(input.db, id)))
		).flatMap((found) => found);
		if (members.length < 2) continue;
		const plans = equalizeGroup(
			members.map((row) => ({
				id: row.id,
				usdtMinor: Number(row.price_minor),
				alipayMinor:
					row.alipay_minor === null ? null : Number(row.alipay_minor),
				agentMinor:
					row.agent_price_minor === null ? null : Number(row.agent_price_minor),
			})),
		);
		for (const row of members) {
			const plan = plans.get(row.id);
			if (!plan) continue;
			const cost = baselines[row.id] ?? 0;
			const applied = await applyPlan(input.db, row, plan, {
				costMinor: cost,
				floorMinor,
				now,
				action: "pricing_guard.equal_group",
			});
			outcomes.push({
				label: `${row.product_name} · ${row.item_name}（同组同价）`,
				costMinor: cost,
				plan,
				applied,
				itemId: row.id,
			});
		}
	}
	// Linked items last: they follow their base item's final prices.
	const links = linkedItemsSchema.safeParse(
		settings.get(pricingGuardSettingKeys.linkedItems),
	);
	for (const link of links.success ? links.data : []) {
		const [[row], [base]] = await Promise.all([
			loadItems(input.db, link.item),
			loadItems(input.db, link.base),
		]);
		if (!row || !base) continue;
		const prices = (item: ItemRow, cost: string | null) => ({
			usdtMinor: Number(item.price_minor),
			alipayMinor:
				item.alipay_minor === null ? null : Number(item.alipay_minor),
			agentMinor:
				item.agent_price_minor === null ? null : Number(item.agent_price_minor),
			costMinor: Number(cost ?? 0),
		});
		const linked = linkedItemPlan(
			prices(row, row.cost_minor),
			prices(base, base.bound_cost_minor ?? base.cost_minor),
			link,
		);
		if (!linked) continue;
		const applied = await applyPlan(input.db, row, linked.plan, {
			costMinor: linked.costNew,
			floorMinor,
			supplierMinor: linked.costNew,
			now,
			action: "pricing_guard.linked_item",
		});
		// A lost race is retried tomorrow; never turn it into an approval button.
		if (!applied) continue;
		outcomes.push({
			label: `${row.product_name} · ${row.item_name}（跟随 ${base.item_name}）`,
			costMinor: linked.costNew,
			plan: linked.plan,
			applied,
			itemId: row.id,
		});
	}
	// Proposals also move the baseline, so an ignored button is not re-sent daily.
	await settingStatement(
		input.db,
		pricingGuardSettingKeys.costBaselines,
		baselines,
		now,
	).run();

	// Applied drops go straight to the channel notice; the owner hears only of
	// rises, proposals and agent warnings.
	const report = formatPricingReport(
		clock.day,
		outcomes.filter(
			(outcome) =>
				!(
					outcome.applied &&
					outcome.baselineMinor !== undefined &&
					outcome.costMinor < outcome.baselineMinor
				),
		),
		agentWarnings,
		floorMinor,
	);
	const resumeLines = formatRestockResumeLines(resumed);
	const text =
		resumeLines.length > 0
			? [report || `📦 定价守护｜${clock.day}`, ...resumeLines].join("\n")
			: report;
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
		resumed: resumed.filter((outcome) => outcome.resumed).length,
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
	const bound = row.bound_origin ? boundSources[row.bound_origin] : undefined;
	if (row.bound_cost_minor === null || !bound) return null;
	const price = Number(row.bound_cost_minor);
	return {
		supplierMinor: price,
		costMinor: realCostMinor(price, bound, factors),
	};
}

/** Shops GMShop buys from directly, priced with that wallet's cost factor. */
const boundSources: Record<string, CostSource> = {
	"https://aisou.pro": "aisou",
	"https://faka.redeemgpt.com": "86",
};

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
			  item.name AS item_name, item.price_minor, item.version, item.cost_minor,
			  (SELECT price.id FROM sellable_item_channel_prices price
			   JOIN payment_channels channel ON channel.id = price.channel_id
			   WHERE price.sellable_item_id = item.id AND price.enabled = 1
			    AND channel.name = 'USDT' LIMIT 1) AS usdt_price_id,
			  (SELECT price.id FROM sellable_item_channel_prices price
			   JOIN payment_channels channel ON channel.id = price.channel_id
			   WHERE price.sellable_item_id = item.id AND price.enabled = 1
			    AND channel.name = '支付宝' AND channel.price_source_channel_id IS NULL LIMIT 1) AS alipay_price_id,
			  (SELECT price.price_minor FROM sellable_item_channel_prices price
			   JOIN payment_channels channel ON channel.id = price.channel_id
			   WHERE price.sellable_item_id = item.id AND price.enabled = 1
			    AND channel.name = '支付宝' AND channel.price_source_channel_id IS NULL LIMIT 1) AS alipay_minor,
			  (SELECT binding.reference_cost_minor FROM supplier_bindings binding
			   WHERE binding.sellable_item_id = item.id AND binding.enabled = 1
			    AND binding.provider = 'shared_stock'
			    AND binding.normalized_api_origin IN ('https://aisou.pro', 'https://faka.redeemgpt.com')
			   ORDER BY binding.updated_at DESC LIMIT 1) AS bound_cost_minor,
			  (SELECT binding.normalized_api_origin FROM supplier_bindings binding
			   WHERE binding.sellable_item_id = item.id AND binding.enabled = 1
			    AND binding.provider = 'shared_stock'
			    AND binding.normalized_api_origin IN ('https://aisou.pro', 'https://faka.redeemgpt.com')
			   ORDER BY binding.updated_at DESC LIMIT 1) AS bound_origin,
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
             AND item.id <> '${gptUpgradeProduct.itemId}'
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
