import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { getAdminServerContext } from "#/server/context";
import {
	deleteCustomerPrices,
	findCustomer,
	listCustomerPrices,
	upsertCustomerPrice,
} from "./prices";

const minorSchema = z
	.string()
	.trim()
	.regex(/^\d{1,9}$/);

/** Plans, public volume steps and every customer price, for the pricing admin page. */
export const listPricingAdminFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await getAdminServerContext(
			systemPermission("customers", "read"),
		);
		const [items, steps] = await db.$client.batch([
			db.$client.prepare(
				`SELECT item.id, product.name AS product_name, item.name AS item_name,
				 item.price_minor, item.cost_minor, item.maximum_quantity
				 FROM product_sellable_items item JOIN products product ON product.id = item.product_id
				 WHERE item.enabled = 1 AND product.status = 'active'
				 ORDER BY product.sort_order, product.name, item.sort_order, item.name`,
			),
			db.$client.prepare(
				`SELECT sellable_item_id, min_quantity, discount_minor FROM sellable_item_volume_prices
				 ORDER BY sellable_item_id, min_quantity`,
			),
		]);
		return {
			items: (
				(items?.results ?? []) as Array<{
					id: string;
					product_name: string;
					item_name: string;
					price_minor: string;
					cost_minor: string | null;
					maximum_quantity: number;
				}>
			).map((row) => ({
				id: row.id,
				label:
					row.item_name && !row.item_name.startsWith(row.product_name)
						? `${row.product_name}｜${row.item_name}`
						: row.item_name || row.product_name,
				priceMinor: row.price_minor,
				costMinor: row.cost_minor,
				maximumQuantity: Number(row.maximum_quantity),
			})),
			volumeSteps: (
				(steps?.results ?? []) as Array<{
					sellable_item_id: string;
					min_quantity: number;
					discount_minor: string;
				}>
			).map((row) => ({
				itemId: row.sellable_item_id,
				minQuantity: Number(row.min_quantity),
				discountMinor: row.discount_minor,
			})),
			customerPrices: await listCustomerPrices(db.$client),
		};
	},
);

const volumeStepSchema = z.object({
	itemId: z.uuid(),
	minQuantity: z.number().int().min(2).max(1000),
	discountMinor: minorSchema,
});

export const saveVolumeStepFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof volumeStepSchema>) =>
		volumeStepSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db, currentUser } = await getAdminServerContext(
			systemPermission("products", "update"),
		);
		const item = await db.$client
			.prepare("SELECT price_minor FROM product_sellable_items WHERE id = ?")
			.bind(data.itemId)
			.first<{ price_minor: string }>();
		if (!item)
			throw new DomainError("pricing_item_missing", 404, "Plan not found");
		if (
			BigInt(data.discountMinor) <= 0n ||
			BigInt(data.discountMinor) >= BigInt(item.price_minor)
		)
			throw new DomainError(
				"pricing_discount_invalid",
				400,
				"The discount must be above zero and below the price",
			);
		const now = Date.now();
		await db.$client.batch([
			db.$client
				.prepare(
					`INSERT INTO sellable_item_volume_prices (sellable_item_id, min_quantity, discount_minor, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(sellable_item_id, min_quantity) DO UPDATE SET
					  discount_minor = excluded.discount_minor, updated_at = excluded.updated_at`,
				)
				.bind(data.itemId, data.minQuantity, data.discountMinor, now, now),
			db.$client
				.prepare(
					"INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, after, created_at) VALUES (?, ?, 'volume_price.set', 'sellable_item', ?, ?, ?)",
				)
				.bind(
					crypto.randomUUID(),
					currentUser.id,
					data.itemId,
					JSON.stringify(data),
					now,
				),
		]);
		return { ok: true };
	});

const volumeStepKeySchema = volumeStepSchema.pick({
	itemId: true,
	minQuantity: true,
});

export const deleteVolumeStepFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof volumeStepKeySchema>) =>
		volumeStepKeySchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db, currentUser } = await getAdminServerContext(
			systemPermission("products", "update"),
		);
		const now = Date.now();
		await db.$client.batch([
			db.$client
				.prepare(
					"DELETE FROM sellable_item_volume_prices WHERE sellable_item_id = ? AND min_quantity = ?",
				)
				.bind(data.itemId, data.minQuantity),
			db.$client
				.prepare(
					"INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, after, created_at) VALUES (?, ?, 'volume_price.delete', 'sellable_item', ?, ?, ?)",
				)
				.bind(
					crypto.randomUUID(),
					currentUser.id,
					data.itemId,
					JSON.stringify(data),
					now,
				),
		]);
		return { ok: true };
	});

const customerPriceSchema = z.object({
	email: z.string().trim().email().max(254),
	itemId: z.uuid(),
	minQuantity: z.number().int().min(1).max(1000),
	priceMinor: minorSchema,
	alipayMinor: minorSchema.nullable(),
});

export const saveCustomerPriceFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof customerPriceSchema>) =>
		customerPriceSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db, currentUser } = await getAdminServerContext(
			systemPermission("customers", "update"),
		);
		if (BigInt(data.priceMinor) <= 0n)
			throw new DomainError(
				"customer_price_invalid",
				400,
				"Price must be above zero",
			);
		const customer = await findCustomer(db.$client, data.email);
		if (!customer)
			throw new DomainError(
				"customer_price_customer_missing",
				404,
				"No registered account uses this email",
			);
		await upsertCustomerPrice(db.$client, {
			userId: customer.id,
			itemId: data.itemId,
			minQuantity: data.minQuantity,
			priceMinor: data.priceMinor,
			alipayMinor: data.alipayMinor,
			actor: `admin:${currentUser.id}`,
			now: Date.now(),
		});
		return { ok: true };
	});

const customerPriceKeySchema = z.object({
	userId: z.string().min(1).max(128),
	itemId: z.uuid(),
	minQuantity: z.number().int().min(1).max(1000),
});

export const deleteCustomerPriceFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof customerPriceKeySchema>) =>
		customerPriceKeySchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db, currentUser } = await getAdminServerContext(
			systemPermission("customers", "update"),
		);
		await deleteCustomerPrices(db.$client, {
			userId: data.userId,
			itemId: data.itemId,
			minQuantity: data.minQuantity,
			actor: `admin:${currentUser.id}`,
			now: Date.now(),
		});
		return { ok: true };
	});
