import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { decimalToMinor, minorToDecimal } from "#/lib/units";
import { getAdminServerContext } from "#/server/context";
import { supplierExportListingSchema } from "../schema";

export const getSupplierApiConfigurationFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await getAdminServerContext(
		systemPermission("suppliers", "read"),
	);
	const setting = await db.$client
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'commerce.supplier_api_enabled' LIMIT 1",
		)
		.first<{ value: string }>();
	return {
		enabled: setting ? JSON.parse(setting.value) === true : false,
	};
});

export const setSupplierApiConfigurationFn = createServerFn({ method: "POST" })
	.validator((value: { enabled: boolean }) =>
		z.object({ enabled: z.boolean() }).parse(value),
	)
	.handler(async ({ data }) => {
		const { currentUser, db } = await getAdminServerContext(
			systemPermission("suppliers", "update"),
		);
		const now = Date.now();
		await db.$client
			.prepare(`INSERT INTO system_settings
		 (key, value, is_secret, updated_by, created_at, updated_at)
		 VALUES ('commerce.supplier_api_enabled', ?, 0, ?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
		 updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
			.bind(JSON.stringify(data.enabled), currentUser.id, now, now)
			.run();
		return data;
	});

export const listSupplierExportListingsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await getAdminServerContext(
		systemPermission("suppliers", "read"),
	);
	const rows = await db.$client
		.prepare(
			`SELECT item.id, product.name AS product_name, item.name AS item_name,
		 item.price_minor, item.currency, item.currency_decimals,
		 listing.price_minor AS export_price_minor, COALESCE(listing.enabled, 0) AS export_enabled,
		 (SELECT COUNT(*) FROM stock_entries stock WHERE stock.sellable_item_id = item.id AND stock.status = 'available') AS stock_quantity
		 FROM product_sellable_items item JOIN products product ON product.id = item.product_id
		 LEFT JOIN supplier_export_listings listing ON listing.sellable_item_id = item.id
		 WHERE product.status = 'active' AND product.product_type = 'stock'
		  AND item.enabled = 1 AND item.fulfillment_source = 'local'
		 ORDER BY product.sort_order, product.name, item.sort_order, item.name`,
		)
		.all();
	return rows.results.map((row) => ({
		sellableItemId: String(row.id),
		productName: String(row.product_name),
		itemName: String(row.item_name),
		currency: String(row.currency),
		currencyDecimals: Number(row.currency_decimals),
		exportPriceMinor:
			row.export_price_minor == null
				? String(row.price_minor)
				: String(row.export_price_minor),
		exportPrice: minorToDecimal(
			row.export_price_minor == null
				? String(row.price_minor)
				: String(row.export_price_minor),
			Number(row.currency_decimals),
		),
		enabled: Number(row.export_enabled) === 1,
		stockQuantity: Number(row.stock_quantity),
	}));
});

export const setSupplierExportListingFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof supplierExportListingSchema>) =>
		supplierExportListingSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("suppliers", "update"),
		);
		const item = await db.$client
			.prepare(
				`SELECT item.id, item.currency, item.currency_decimals
			 FROM product_sellable_items item JOIN products product ON product.id = item.product_id
			 WHERE item.id = ? AND item.enabled = 1 AND item.fulfillment_source = 'local'
			  AND product.status = 'active' AND product.product_type = 'stock' LIMIT 1`,
			)
			.bind(data.sellableItemId)
			.first<{ id: string; currency: string; currency_decimals: number }>();
		if (!item)
			throw new DomainError(
				"supplier_export_item_not_found",
				404,
				"Sellable item not found",
			);
		let priceMinor: string;
		try {
			priceMinor = decimalToMinor(
				data.price,
				item.currency_decimals,
			).toString();
		} catch {
			throw new DomainError(
				"supplier_export_price_invalid",
				400,
				"Invalid export price",
			);
		}
		const now = Date.now();
		await db.$client.batch([
			db.$client
				.prepare(
					`INSERT INTO supplier_export_listings
				 (id, sellable_item_id, price_minor, currency, currency_decimals, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(sellable_item_id) DO UPDATE SET price_minor = excluded.price_minor,
				 currency = excluded.currency, currency_decimals = excluded.currency_decimals,
				 enabled = excluded.enabled, updated_at = excluded.updated_at`,
				)
				.bind(
					crypto.randomUUID(),
					item.id,
					priceMinor,
					item.currency,
					item.currency_decimals,
					data.enabled ? 1 : 0,
					now,
					now,
				),
			db.$client
				.prepare(
					`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
				 VALUES (?, ?, 'supplier_api.export_listing_saved', 'sellable_item', ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					currentUser.id,
					item.id,
					request.headers.get("x-request-id"),
					request.headers.get("cf-connecting-ip"),
					JSON.stringify({
						enabled: data.enabled,
						priceMinor,
						currency: item.currency,
					}),
					now,
				),
		]);
		return {
			sellableItemId: item.id,
			enabled: data.enabled,
			priceMinor,
			price: minorToDecimal(priceMinor, item.currency_decimals),
		};
	});
