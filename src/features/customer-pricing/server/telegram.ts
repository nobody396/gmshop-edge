import { z } from "zod";
import {
	beijingClock,
	claimPeriod,
	loadSettings,
	settingStatement,
} from "#/features/ops-automation/server/shared";
import {
	type OwnerActionContext,
	proposeOwnerAction,
} from "#/features/telegram/server/owner-actions";
import { DomainError } from "#/lib/domain-error";
import {
	alipayPrice,
	deleteCustomerPrices,
	findCustomer,
	listCustomerPrices,
	loadPricedItem,
	marginMinor,
	matchItems,
	type PricedItem,
	upsertCustomerPrice,
} from "./prices";

/**
 * Owner commands in the owner-alert chat:
 *   /vip [邮箱]                          list customer prices
 *   /vipprice 邮箱 商品 [N张起] 价格[/支付宝价]
 *   /vipdel 邮箱 商品 [N张起]
 * Every change is a confirmation card first; nothing changes until "确认".
 */
type Context = OwnerActionContext & { fetcher?: typeof fetch };

const confirmTtlMs = 60 * 60_000;
const maxCandidates = 6;
export const vipUsage = [
	"用法：",
	"/vip 邮箱 —— 查看这个客户的专属价（不带邮箱：列出所有有专属价的客户）",
	"/vipprice 邮箱 商品 价格 —— 一口价，例：/vipprice a@b.com Plus菲区 115",
	"/vipprice 邮箱 商品 N张起 价格 —— 阶梯价，例：/vipprice a@b.com Plus菲区 10张起 113",
	"价格写 USDT 价；要单独定支付宝价写成 115/121。只写一个时支付宝自动加平时的差价",
	"/vipdel 邮箱 商品 [N张起] —— 删除（不写张数就删掉这个商品的全部专属价）",
].join("\n");

const emailPattern = /^\S+@\S+\.\S+$/;
const quantityPattern = /^(\d{1,4})张起$/;
const pricePattern = /^(\d{1,6}(?:\.\d{1,2})?)(?:\/(\d{1,6}(?:\.\d{1,2})?))?$/;

function toMinor(yuan: string) {
	const [whole = "0", fraction = ""] = yuan.split(".");
	return (
		BigInt(whole) * 100n +
		BigInt(fraction.padEnd(2, "0").slice(0, 2))
	).toString();
}

function yuan(minor: string | bigint) {
	const value = BigInt(minor);
	const sign = value < 0n ? "-" : "";
	const abs = value < 0n ? -value : value;
	return `${sign}¥${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

function quantityLabel(minQuantity: number) {
	return minQuantity <= 1 ? "一口价（任意数量）" : `${minQuantity} 张起`;
}

export async function vipCommand(context: Context, args: string) {
	const email = args.trim();
	if (!email) {
		const rows = await listCustomerPrices(context.db);
		if (rows.length === 0) return `还没有客户专属价。\n\n${vipUsage}`;
		const byEmail = new Map<string, number>();
		for (const row of rows)
			byEmail.set(row.email, (byEmail.get(row.email) ?? 0) + 1);
		return [
			`有专属价的客户（${byEmail.size} 个）：`,
			...[...byEmail].map(([address, count]) => `• ${address}：${count} 条`),
			"",
			"查看某个客户：/vip 邮箱",
		].join("\n");
	}
	if (!emailPattern.test(email)) return vipUsage;
	const customer = await findCustomer(context.db, email);
	if (!customer)
		return `找不到已注册的账号：${email}（请让客户先在 laoshirenvip.com 注册）`;
	const rows = await listCustomerPrices(context.db, { userId: customer.id });
	if (rows.length === 0) return `${customer.email} 还没有专属价。`;
	return [
		`👤 ${customer.email} 的专属价：`,
		...rows.map(
			(row) =>
				`• ${row.itemLabel}｜${quantityLabel(row.minQuantity)}｜USDT ${yuan(row.priceMinor)} / 支付宝 ${yuan(row.alipayMinor)}`,
		),
	].join("\n");
}

const setPayloadSchema = z.object({
	userId: z.string(),
	email: z.string(),
	itemIds: z.array(z.string()).min(1).max(maxCandidates),
	minQuantity: z.number().int().min(1).max(1000),
	priceMinor: z.string().regex(/^\d+$/),
	alipayMinor: z.string().regex(/^\d+$/).nullable(),
});

export async function vipPriceCommand(context: Context, args: string) {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const email = parts.shift() ?? "";
	const price = pricePattern.exec(parts.pop() ?? "");
	const quantity = quantityPattern.exec(parts.at(-1) ?? "");
	if (quantity) parts.pop();
	const query = parts.join(" ");
	if (!emailPattern.test(email) || !price || !query) return vipUsage;
	const minQuantity = quantity ? Number(quantity[1]) : 1;
	if (minQuantity < 1 || minQuantity > 1000) return "张数要在 1–1000 之间";
	const priceMinor = toMinor(price[1] ?? "0");
	const alipayMinor = price[2] ? toMinor(price[2]) : null;
	if (
		BigInt(priceMinor) <= 0n ||
		(alipayMinor !== null && BigInt(alipayMinor) <= 0n)
	)
		return "价格要大于 0";
	const customer = await findCustomer(context.db, email);
	if (!customer)
		return `找不到已注册的账号：${email}（请让客户先在 laoshirenvip.com 注册）`;
	const items = await matchItems(context.db, query);
	if (items.length === 0)
		return `找不到商品「${query}」。可以写得短一点，比如 Plus菲区、Pro200续费、Pro500智利`;
	if (items.length > maxCandidates)
		return `「${query}」匹配到 ${items.length} 个规格，请写得更具体一些：\n${items
			.slice(0, 10)
			.map((item) => `• ${item.label}`)
			.join("\n")}`;
	const lines = [
		"👤 客户专属价确认",
		`客户：${customer.email}`,
		`数量：${quantityLabel(minQuantity)}`,
	];
	if (items.length === 1)
		lines.push(...priceLines(items[0] as PricedItem, priceMinor, alipayMinor));
	else
		lines.push(
			`专属价：USDT ${yuan(priceMinor)}${alipayMinor ? ` / 支付宝 ${yuan(alipayMinor)}` : "（支付宝自动加平时的差价）"}`,
			`「${query}」匹配到 ${items.length} 个规格，点要设置的那一个：`,
		);
	lines.push("1 小时内有效。");
	await proposeOwnerAction(context.db, {
		kind: "customer_price_set",
		payload: {
			userId: customer.id,
			email: customer.email,
			itemIds: items.map((item) => item.id),
			minQuantity,
			priceMinor,
			alipayMinor,
		} satisfies z.infer<typeof setPayloadSchema>,
		text: lines.join("\n"),
		choices:
			items.length === 1
				? ["✅ 确认设置"]
				: items.map((item, index) => `${index + 1}. ${item.label}`),
		rejectLabel: "❌ 取消",
		fallback: null,
		ttlMs: confirmTtlMs,
		now: context.now,
		fetcher: context.fetcher,
	});
	return null;
}

function priceLines(
	item: PricedItem,
	priceMinor: string,
	alipayMinor: string | null,
) {
	const alipay = alipayPrice(item, priceMinor, alipayMinor);
	const usdtMargin = marginMinor(priceMinor, 0, item.costMinor);
	const alipayMargin = item.alipay
		? marginMinor(alipay, item.alipay.feeBps, item.costMinor)
		: null;
	const lines = [
		`商品：${item.label}`,
		`专属价：USDT ${yuan(priceMinor)}${item.alipay ? ` / 支付宝 ${yuan(alipay)}` : ""}`,
		`公开价：USDT ${yuan(item.priceMinor)}${item.alipay ? ` / 支付宝 ${yuan(item.alipay.priceMinor)}` : ""}`,
	];
	if (item.costMinor !== null && usdtMargin !== null)
		lines.push(
			`进价 ${yuan(item.costMinor)}，每张赚：USDT ${yuan(usdtMargin)}${alipayMargin !== null ? ` / 支付宝 ${yuan(alipayMargin)}（已扣手续费）` : ""}`,
		);
	else lines.push("这个规格没有登记进价，算不出利润。");
	const loss = [usdtMargin, alipayMargin].some(
		(margin) => margin !== null && margin < 0n,
	);
	if (loss) lines.push("⚠️ 低于进价：按这个价每张会亏钱，确认前请再看一眼");
	return lines;
}

export async function approveCustomerPriceSet(
	context: Context,
	rawPayload: unknown,
	choice: number,
) {
	const payload = setPayloadSchema.parse(rawPayload);
	const itemId = payload.itemIds[choice];
	if (!itemId)
		throw new DomainError("customer_price_choice_invalid", 409, "没有这个选项");
	const item = await upsertCustomerPrice(context.db, {
		userId: payload.userId,
		itemId,
		minQuantity: payload.minQuantity,
		priceMinor: payload.priceMinor,
		alipayMinor: payload.alipayMinor,
		actor: `telegram:${context.decidedBy ?? "owner"}`,
		now: context.now,
	});
	return `✅ 已设置：${payload.email}｜${item.label}｜${quantityLabel(payload.minQuantity)}｜USDT ${yuan(payload.priceMinor)}${item.alipay ? ` / 支付宝 ${yuan(alipayPrice(item, payload.priceMinor, payload.alipayMinor))}` : ""}。客户登录后立即生效`;
}

const deletePayloadSchema = z.object({
	userId: z.string(),
	email: z.string(),
	itemIds: z.array(z.string()).min(1).max(maxCandidates),
	minQuantity: z.number().int().nullable(),
});

export async function vipDeleteCommand(context: Context, args: string) {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const email = parts.shift() ?? "";
	const quantity = quantityPattern.exec(parts.at(-1) ?? "");
	if (quantity) parts.pop();
	const query = parts.join(" ");
	if (!emailPattern.test(email) || !query) return vipUsage;
	const customer = await findCustomer(context.db, email);
	if (!customer) return `找不到已注册的账号：${email}`;
	const existing = await listCustomerPrices(context.db, {
		userId: customer.id,
	});
	const matched = new Set(
		(await matchItems(context.db, query)).map((item) => item.id),
	);
	const minQuantity = quantity ? Number(quantity[1]) : null;
	const rows = existing.filter(
		(row) =>
			matched.has(row.itemId) &&
			(minQuantity === null || row.minQuantity === minQuantity),
	);
	const itemIds = [...new Set(rows.map((row) => row.itemId))];
	if (itemIds.length === 0)
		return `${customer.email} 在「${query}」上没有专属价。`;
	if (itemIds.length > maxCandidates)
		return "匹配到的规格太多，请写得更具体一些";
	await proposeOwnerAction(context.db, {
		kind: "customer_price_delete",
		payload: {
			userId: customer.id,
			email: customer.email,
			itemIds,
			minQuantity,
		} satisfies z.infer<typeof deletePayloadSchema>,
		text: [
			"🗑 删除客户专属价",
			`客户：${customer.email}`,
			...rows.map(
				(row) =>
					`• ${row.itemLabel}｜${quantityLabel(row.minQuantity)}｜USDT ${yuan(row.priceMinor)} / 支付宝 ${yuan(row.alipayMinor)}`,
			),
			"删除后这个客户按公开价购买。1 小时内有效。",
		].join("\n"),
		choices:
			itemIds.length === 1
				? ["✅ 确认删除"]
				: itemIds.map(
						(id, index) =>
							`${index + 1}. 删除 ${rows.find((row) => row.itemId === id)?.itemLabel ?? id}`,
					),
		rejectLabel: "❌ 取消",
		fallback: null,
		ttlMs: confirmTtlMs,
		now: context.now,
		fetcher: context.fetcher,
	});
	return null;
}

export async function approveCustomerPriceDelete(
	context: Context,
	rawPayload: unknown,
	choice: number,
) {
	const payload = deletePayloadSchema.parse(rawPayload);
	const itemId = payload.itemIds[choice];
	if (!itemId)
		throw new DomainError("customer_price_choice_invalid", 409, "没有这个选项");
	const item = await loadPricedItem(context.db, itemId);
	const removed = await deleteCustomerPrices(context.db, {
		userId: payload.userId,
		itemId,
		minQuantity: payload.minQuantity,
		actor: `telegram:${context.decidedBy ?? "owner"}`,
		now: context.now,
	});
	return `🗑 已删除 ${removed} 条：${payload.email}｜${item?.label ?? itemId}`;
}

// ---- Loss guard: a customer price never follows cost changes, so the owner is told when it starts losing money.

const raisePayloadSchema = z.object({
	priceId: z.string(),
	priceMinor: z.string().regex(/^\d+$/),
	newPriceMinor: z.string().regex(/^\d+$/),
});

export async function approveCustomerPriceRaise(
	context: Context,
	rawPayload: unknown,
) {
	const payload = raisePayloadSchema.parse(rawPayload);
	const changed = await context.db
		.prepare(
			`UPDATE customer_item_prices SET price_minor = ?, channel_prices_json = '{}',
			 cost_minor_at_set = (SELECT cost_minor FROM product_sellable_items WHERE id = customer_item_prices.sellable_item_id),
			 updated_at = ? WHERE id = ? AND price_minor = ?`,
		)
		.bind(
			payload.newPriceMinor,
			context.now,
			payload.priceId,
			payload.priceMinor,
		)
		.run();
	if (Number(changed.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"customer_price_changed",
			409,
			"这条专属价已经改过或删掉了",
		);
	return `✅ 已上调到 USDT ${yuan(payload.newPriceMinor)}（支付宝自动加平时的差价）`;
}

/**
 * Daily: a customer price whose USDT or Alipay margin turned negative gets one
 * proposal per cost level, offering the new cost plus the margin it was set with.
 */
export async function proposeLosingCustomerPrices(
	context: Context,
	alerted: Record<string, string>,
) {
	const rows = await listCustomerPrices(context.db);
	const next: Record<string, string> = {};
	let proposals = 0;
	for (const row of rows) {
		if (row.costMinor === null) continue;
		const item = await loadPricedItem(context.db, row.itemId);
		const usdt = marginMinor(row.priceMinor, 0, row.costMinor);
		const alipay = item?.alipay
			? marginMinor(row.alipayMinor, item.alipay.feeBps, row.costMinor)
			: null;
		if (!((usdt !== null && usdt < 0n) || (alipay !== null && alipay < 0n)))
			continue;
		next[row.id] = row.costMinor;
		if (alerted[row.id] === row.costMinor) continue;
		const marginAtSet =
			row.costMinorAtSet !== null
				? BigInt(row.priceMinor) - BigInt(row.costMinorAtSet)
				: 0n;
		const newPriceMinor = (
			BigInt(row.costMinor) + (marginAtSet > 0n ? marginAtSet : 0n)
		).toString();
		const proposal = await proposeOwnerAction(context.db, {
			kind: "customer_price_raise",
			payload: {
				priceId: row.id,
				priceMinor: row.priceMinor,
				newPriceMinor,
			} satisfies z.infer<typeof raisePayloadSchema>,
			text: [
				"📈 客户专属价开始亏钱",
				`客户：${row.email}`,
				`商品：${row.itemLabel}｜${quantityLabel(row.minQuantity)}`,
				`专属价 USDT ${yuan(row.priceMinor)} / 支付宝 ${yuan(row.alipayMinor)}，现在进价 ${yuan(row.costMinor)}`,
				`每张：USDT ${yuan(usdt ?? 0n)}${alipay !== null ? ` / 支付宝 ${yuan(alipay)}（已扣手续费）` : ""}`,
				`建议按新进价加原来的利润，上调到 USDT ${yuan(newPriceMinor)}。`,
			].join("\n"),
			choices: [`✅ 上调到 ${yuan(newPriceMinor)}`],
			rejectLabel: "保持不变",
			fallback: null,
			now: context.now,
			fetcher: context.fetcher,
		}).catch(() => null);
		if (proposal) proposals += 1;
	}
	return { alerted: next, proposals };
}

const guardDayKey = "ops.customer_price_guard.day";
const guardAlertedKey = "ops.customer_price_guard.alerted";

/** Minute cron; runs once per Beijing day after 09:30. */
export async function runCustomerPriceGuard(input: {
	db: D1Database;
	now: number;
	fetcher?: typeof fetch;
}) {
	const clock = beijingClock(input.now);
	const minutes = clock.hour * 60 + new Date(input.now).getUTCMinutes();
	if (minutes < 9 * 60 + 30) return { status: "waiting" as const };
	if (!(await claimPeriod(input.db, guardDayKey, clock.day, input.now)))
		return { status: "done" as const };
	const settings = await loadSettings(input.db, [guardAlertedKey]);
	const alerted = z
		.record(z.string(), z.string())
		.catch({})
		.parse(settings.get(guardAlertedKey) ?? {});
	const result = await proposeLosingCustomerPrices(
		{ db: input.db, cache: undefined, now: input.now, fetcher: input.fetcher },
		alerted,
	);
	await settingStatement(
		input.db,
		guardAlertedKey,
		result.alerted,
		input.now,
	).run();
	return { status: "ran" as const, proposals: result.proposals };
}
