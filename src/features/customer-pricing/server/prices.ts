import { DomainError } from "#/lib/domain-error";

/**
 * Prices agreed with one registered customer (see drizzle/0043). The base
 * price is what USDT and balance pay; Alipay pays the base plus the item's
 * usual Alipay difference unless a price is named for it.
 */
export type PricedItem = {
	id: string;
	label: string;
	priceMinor: string;
	costMinor: string | null;
	alipay: { channelId: string; priceMinor: string; feeBps: number } | null;
};

export type CustomerPriceRow = {
	id: string;
	userId: string;
	email: string;
	itemId: string;
	itemLabel: string;
	minQuantity: number;
	priceMinor: string;
	alipayMinor: string;
	alipayNamed: boolean;
	listPriceMinor: string;
	listAlipayMinor: string | null;
	costMinor: string | null;
	costMinorAtSet: string | null;
	updatedAt: number;
};

function auditStatement(
	db: D1Database,
	input: {
		action: string;
		userId: string;
		after: Record<string, unknown>;
		now: number;
	},
) {
	return db
		.prepare(
			"INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at) VALUES (?, ?, 'user', ?, ?, ?)",
		)
		.bind(
			crypto.randomUUID(),
			input.action,
			input.userId,
			JSON.stringify(input.after),
			input.now,
		);
}

export async function findCustomer(db: D1Database, email: string) {
	return db
		.prepare(
			"SELECT id, email FROM users WHERE lower(email) = lower(?) AND enabled = 1 LIMIT 1",
		)
		.bind(email.trim())
		.first<{ id: string; email: string }>();
}

const itemColumns = `item.id, product.name AS product_name, item.name AS item_name,
	item.price_minor, item.cost_minor,
	alipay.channel_id AS alipay_channel_id, alipay.price_minor AS alipay_price_minor,
	channel.fee_bps AS alipay_fee_bps`;
const itemJoins = `FROM product_sellable_items item
	JOIN products product ON product.id = item.product_id
	LEFT JOIN payment_channels channel ON channel.provider = 'epay' AND channel.enabled = 1
	LEFT JOIN sellable_item_channel_prices alipay
	 ON alipay.sellable_item_id = item.id AND alipay.channel_id = channel.id AND alipay.enabled = 1`;

type ItemRow = {
	id: string;
	product_name: string;
	item_name: string;
	price_minor: string;
	cost_minor: string | null;
	alipay_channel_id: string | null;
	alipay_price_minor: string | null;
	alipay_fee_bps: number | null;
};

function presentItem(row: ItemRow): PricedItem {
	return {
		id: row.id,
		label:
			row.item_name && !row.item_name.startsWith(row.product_name)
				? `${row.product_name}｜${row.item_name}`
				: row.item_name || row.product_name,
		priceMinor: row.price_minor,
		costMinor: row.cost_minor,
		alipay:
			row.alipay_channel_id && row.alipay_price_minor
				? {
						channelId: row.alipay_channel_id,
						priceMinor: row.alipay_price_minor,
						feeBps: Number(row.alipay_fee_bps ?? 0),
					}
				: null,
	};
}

export async function loadPricedItem(db: D1Database, itemId: string) {
	const row = await db
		.prepare(`SELECT ${itemColumns} ${itemJoins} WHERE item.id = ? LIMIT 1`)
		.bind(itemId)
		.first<ItemRow>();
	return row ? presentItem(row) : null;
}

/** "Plus菲区" / "pro 200 续费": every letter run, digit run and CJK run must appear in the plan's name. */
export async function matchItems(db: D1Database, query: string) {
	const tokens =
		query
			.toLowerCase()
			.match(/[a-z]+|\d+|[㐀-鿿]+/g)
			?.filter(Boolean) ?? [];
	if (tokens.length === 0) return [];
	const rows = await db
		.prepare(
			`SELECT ${itemColumns} ${itemJoins}
			 WHERE item.enabled = 1 AND product.status = 'active'
			 ORDER BY product.sort_order, product.name, item.sort_order, item.name`,
		)
		.all<ItemRow>();
	return rows.results
		.filter((row) => {
			const name = `${row.product_name}${row.item_name}`
				.toLowerCase()
				.replace(/\s+/g, "");
			return tokens.every((token) => name.includes(token));
		})
		.map(presentItem);
}

/** Alipay price for a base price: the named one, else the item's usual difference added. */
export function alipayPrice(
	item: PricedItem,
	priceMinor: string,
	named: string | null,
) {
	if (named) return named;
	if (!item.alipay) return priceMinor;
	return (
		BigInt(priceMinor) +
		BigInt(item.alipay.priceMinor) -
		BigInt(item.priceMinor)
	).toString();
}

/** Net per card after the channel fee, minus the current cost; null without a cost. */
export function marginMinor(
	priceMinor: string,
	feeBps: number,
	costMinor: string | null,
) {
	if (costMinor === null) return null;
	const net = (BigInt(priceMinor) * BigInt(10_000 - feeBps)) / 10_000n;
	return net - BigInt(costMinor);
}

export async function upsertCustomerPrice(
	db: D1Database,
	input: {
		userId: string;
		itemId: string;
		minQuantity: number;
		priceMinor: string;
		alipayMinor: string | null;
		actor: string;
		now: number;
	},
) {
	const item = await loadPricedItem(db, input.itemId);
	if (!item)
		throw new DomainError("customer_price_item_missing", 404, "商品规格不存在");
	if (input.alipayMinor && !item.alipay)
		throw new DomainError(
			"customer_price_alipay_missing",
			409,
			"这个规格没有支付宝价，不能单独设置支付宝价",
		);
	const channelPrices =
		input.alipayMinor && item.alipay
			? { [item.alipay.channelId]: input.alipayMinor }
			: {};
	const id = crypto.randomUUID();
	await db.batch([
		db
			.prepare(
				`INSERT INTO customer_item_prices
				 (id, user_id, sellable_item_id, min_quantity, price_minor, channel_prices_json,
				  cost_minor_at_set, created_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(user_id, sellable_item_id, min_quantity) DO UPDATE SET
				  price_minor = excluded.price_minor,
				  channel_prices_json = excluded.channel_prices_json,
				  cost_minor_at_set = excluded.cost_minor_at_set,
				  created_by = excluded.created_by,
				  updated_at = excluded.updated_at`,
			)
			.bind(
				id,
				input.userId,
				input.itemId,
				input.minQuantity,
				input.priceMinor,
				JSON.stringify(channelPrices),
				item.costMinor,
				input.actor,
				input.now,
				input.now,
			),
		auditStatement(db, {
			action: "customer_price.set",
			userId: input.userId,
			after: {
				itemId: input.itemId,
				minQuantity: input.minQuantity,
				priceMinor: input.priceMinor,
				alipayMinor: input.alipayMinor,
				actor: input.actor,
			},
			now: input.now,
		}),
	]);
	return item;
}

export async function deleteCustomerPrices(
	db: D1Database,
	input: {
		userId: string;
		itemId: string;
		minQuantity: number | null;
		actor: string;
		now: number;
	},
) {
	const [deleted] = await db.batch([
		db
			.prepare(
				`DELETE FROM customer_item_prices WHERE user_id = ? AND sellable_item_id = ?
				 AND (? IS NULL OR min_quantity = ?)`,
			)
			.bind(input.userId, input.itemId, input.minQuantity, input.minQuantity),
		auditStatement(db, {
			action: "customer_price.delete",
			userId: input.userId,
			after: {
				itemId: input.itemId,
				minQuantity: input.minQuantity,
				actor: input.actor,
			},
			now: input.now,
		}),
	]);
	return Number(deleted?.meta.changes ?? 0);
}

export async function listCustomerPrices(
	db: D1Database,
	filter: { userId?: string | null } = {},
): Promise<CustomerPriceRow[]> {
	const rows = await db
		.prepare(
			`SELECT price.id AS price_id, price.user_id, users.email, price.sellable_item_id, price.min_quantity,
			 price.price_minor AS agreed_price_minor, price.channel_prices_json, price.cost_minor_at_set, price.updated_at,
			 ${itemColumns}
			 FROM customer_item_prices price
			 JOIN users ON users.id = price.user_id
			 JOIN product_sellable_items item ON item.id = price.sellable_item_id
			 JOIN products product ON product.id = item.product_id
			 LEFT JOIN payment_channels channel ON channel.provider = 'epay' AND channel.enabled = 1
			 LEFT JOIN sellable_item_channel_prices alipay
			  ON alipay.sellable_item_id = item.id AND alipay.channel_id = channel.id AND alipay.enabled = 1
			 WHERE (? IS NULL OR price.user_id = ?)
			 ORDER BY users.email, product.sort_order, item.sort_order, price.min_quantity`,
		)
		.bind(filter.userId ?? null, filter.userId ?? null)
		.all<
			ItemRow & {
				price_id: string;
				agreed_price_minor: string;
				user_id: string;
				email: string;
				sellable_item_id: string;
				min_quantity: number;
				channel_prices_json: string;
				cost_minor_at_set: string | null;
				updated_at: number;
			}
		>();
	return rows.results.map((row) => {
		const item = presentItem(row);
		let named: string | null = null;
		try {
			const prices = JSON.parse(row.channel_prices_json) as Record<
				string,
				string
			>;
			named = item.alipay ? (prices[item.alipay.channelId] ?? null) : null;
		} catch {
			named = null;
		}
		const priceMinor = row.agreed_price_minor;
		return {
			id: row.price_id,
			userId: row.user_id,
			email: row.email,
			itemId: row.sellable_item_id,
			itemLabel: item.label,
			minQuantity: Number(row.min_quantity),
			priceMinor,
			alipayMinor: alipayPrice(item, priceMinor, named),
			alipayNamed: named !== null,
			listPriceMinor: item.priceMinor,
			listAlipayMinor: item.alipay?.priceMinor ?? null,
			costMinor: item.costMinor,
			costMinorAtSet: row.cost_minor_at_set,
			updatedAt: Number(row.updated_at),
		};
	});
}
