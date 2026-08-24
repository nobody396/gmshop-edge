import { z } from "zod";
import { DomainError } from "#/lib/domain-error";
import { decimalToMinor } from "../money";
import type { SupplierPurchaseResult } from "../schema";
import { supplierFetchJson } from "./http";
import { signSharedStockForm } from "./signatures";
import type { SupplierAdapter, SupplierProduct, SupplierSku } from "./types";

// acg-faka "共享店铺" (SharedStock) docking protocol. The merchant identity is
// an upstream user account: appId/app_key authenticate every form request and
// the signature is a body field, not a header. Endpoints verified against the
// open-source server implementation (app/Controller/Shared/*) and probed live
// on web3chirou.com, aisou.pro, and cool.cheggnow.com.
//
// The same controllers are exposed through two route families: the core
// "new" /shared/{controller}/{action} routes (always available) and the
// legacy paid SharedStock plugin at /plugin/SharedStock/api/{action}. New
// routes are tried first; the legacy path is a fallback only when the first
// response is definitively not JSON (the plugin-disabled notice page), never
// after a request reached the server or its outcome is uncertain.
const CORE_ACTIONS: Record<string, string> = {
	connect: "/shared/authentication/connect",
	items: "/shared/commodity/items",
	item: "/shared/commodity/item",
	stock: "/shared/commodity/stock",
	inventory: "/shared/commodity/inventory",
	inventoryState: "/shared/commodity/inventoryState",
	valuation: "/shared/commodity/valuation",
	trade: "/shared/commodity/trade",
	query: "/shared/commodity/query",
};
const LEGACY_PREFIX = "/plugin/SharedStock/api";

// One commodity = one sellable SKU. The stable cross-endpoint identifier is
// the 对接CODE, so both productId and skuId use it. race/sku variants are not
// modeled in this adapter version.
const commoditySchema = z.object({
	id: z.union([z.string(), z.number()]),
	code: z.string().min(1).max(256),
	name: z.string().max(512),
	description: z.string().max(640_000).default(""),
	cover: z.string().max(2048).default(""),
	price: z.union([z.string(), z.number()]),
	stock: z.union([z.string(), z.number()]).nullable().default(null),
	config: z.union([z.string(), z.record(z.string(), z.unknown())]).default(""),
});

const categorySchema = z.object({
	id: z.union([z.string(), z.number()]),
	name: z.string().max(512),
	children: z.array(commoditySchema).max(10_000).default([]),
});

const inventorySchema = z.object({
	count: z.union([z.string(), z.number()]),
	delivery_way: z.union([z.string(), z.number()]),
	price: z.union([z.string(), z.number()]),
	user_price: z.union([z.string(), z.number()]).default(0),
	factory_price: z.union([z.string(), z.number()]).default(0),
	config: z.union([z.string(), z.record(z.string(), z.unknown())]).default(""),
});

const valuationSchema = z.object({
	price: z.union([z.string(), z.number()]),
});

const tradeSchema = z.object({
	url: z.string().max(2048).default(""),
	amount: z.union([z.string(), z.number()]).default(""),
	tradeNo: z.union([z.string(), z.number()]),
	secret: z.string().max(640_000).default(""),
});

const querySchema = z.object({
	secret: z.string().max(640_000).default(""),
	status: z.union([z.string(), z.number()]).default(0),
});

export class SharedStockAdapter implements SupplierAdapter {
	constructor(
		private readonly input: {
			baseUrl: string;
			appId: string;
			appKey: string;
			currency: string;
			currencyDecimals: number;
			fetcher?: typeof fetch;
		},
	) {}

	async testConnection() {
		const data = z
			.object({
				shopName: z.string().max(512),
				balance: z.union([z.string(), z.number()]),
			})
			.parse(await this.request("/connect"));
		return {
			siteName: data.shopName,
			balance: {
				amountMinor: decimalToMinor(
					String(data.balance),
					this.input.currencyDecimals,
				),
				currency: this.input.currency,
			},
		};
	}

	async listProducts(input: { page: number; pageSize: number }) {
		const categories = z
			.array(categorySchema)
			.max(1_000)
			.parse(await this.request("/items"));
		const products = categories.flatMap((category) =>
			category.children.map(
				(commodity): SupplierProduct => ({
					id: commodity.code,
					name: commodity.name,
					description: commodity.description,
					// Upstream covers are site-relative paths.
					imageUrls: commodity.cover
						? [new URL(commodity.cover, this.input.baseUrl).href]
						: [],
					categoryNames: [category.name],
					active: true,
					skus: commoditySkus(commodity, this.input.currencyDecimals),
				}),
			),
		);
		const start = Math.max(0, (input.page - 1) * input.pageSize);
		return {
			total: products.length,
			products: products.slice(start, start + input.pageSize),
		};
	}

	async getSku(productId: string, skuId: string) {
		const descriptor = decodeSharedSkuId(skuId);
		if (descriptor.code !== productId) throw notFound();
		const inventoryPromise = this.request("/inventory", {
			sharedCode: productId,
			...(descriptor.race ? { race: descriptor.race } : {}),
		});
		const [data, valuation] = await Promise.all([
			inventoryPromise.then((value) => inventorySchema.parse(value)),
			descriptor.race
				? this.request("/valuation", {
						code: productId,
						num: "1",
						race: descriptor.race,
						card_id: "0",
					}).then((value) => valuationSchema.parse(value))
				: Promise.resolve(null),
		]);
		const cost =
			valuation?.price ?? preferredInventoryCost(data, descriptor.race);
		return {
			id: skuId,
			name: descriptor.race ?? productId,
			costMinor: decimalToMinor(String(cost), this.input.currencyDecimals),
			stockQuantity: normalizeStock(data.count),
			active: true,
		} satisfies SupplierSku;
	}

	async submitOrder(input: {
		skuId: string;
		quantity: number;
		requestNo: string;
		callbackUrl: string;
		traceId: string;
	}): Promise<SupplierPurchaseResult> {
		const descriptor = decodeSharedSkuId(input.skuId);
		const data = tradeSchema.parse(
			await this.request("/trade", {
				shared_code: descriptor.code,
				num: String(input.quantity),
				contact: input.requestNo,
				device: "0",
				request_no: input.requestNo,
				...(descriptor.race ? { race: descriptor.race } : {}),
			}),
		);
		const cards = parseCards(data.secret);
		return cards.length
			? {
					status: "supplied",
					upstreamOrderId: String(data.tradeNo),
					cards,
				}
			: {
					status: "processing",
					upstreamOrderId: String(data.tradeNo),
				};
	}

	async reconcileOrder(input: {
		upstreamOrderId: string | null;
		skuId: string;
		quantity: number;
		requestNo: string;
		callbackUrl: string;
		traceId: string;
	}): Promise<SupplierPurchaseResult> {
		// The protocol has no query-by-request_no endpoint, so an order whose
		// upstream trade number was never received cannot be reconciled
		// automatically; keep it uncertain for operator review.
		if (!input.upstreamOrderId)
			throw new DomainError(
				"supplier_request_uncertain",
				502,
				"Supplier request outcome is uncertain",
			);
		const data = querySchema.parse(
			await this.request("/query", { tradeNo: input.upstreamOrderId }),
		);
		const cards = parseCards(data.secret);
		return cards.length
			? {
					status: "supplied",
					upstreamOrderId: input.upstreamOrderId,
					cards,
				}
			: {
					status: "processing",
					upstreamOrderId: input.upstreamOrderId,
				};
	}

	private routeFamily: "core" | "legacy" | null = null;

	private async request(action: string, data: Record<string, string> = {}) {
		const corePath = CORE_ACTIONS[action.slice(1)];
		if (!corePath) throw new Error(`shared_stock_unknown_action:${action}`);
		const legacyPath = `${LEGACY_PREFIX}${action}`;
		const candidates =
			this.routeFamily === "legacy"
				? [legacyPath]
				: this.routeFamily === "core"
					? [corePath]
					: [corePath, legacyPath];

		const payload = { ...data, app_id: this.input.appId };
		const form = new URLSearchParams({
			...payload,
			sign: signSharedStockForm(payload, this.input.appKey),
		});
		let lastError: unknown;
		for (const [index, path] of candidates.entries()) {
			let status: number;
			let body: unknown;
			try {
				({ status, body } = await supplierFetchJson(
					this.input.fetcher ?? fetch,
					`${this.input.baseUrl}${path}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: form.toString(),
					},
					{ validateDestination: !this.input.fetcher },
				));
			} catch (error) {
				// Only a definitively non-processed response (the legacy plugin
				// notice page fails JSON parsing) justifies trying the other
				// route family; anything uncertain must not be replayed.
				if (
					error instanceof DomainError &&
					error.code === "invalid_supplier_response" &&
					index < candidates.length - 1
				) {
					lastError = error;
					continue;
				}
				throw error;
			}
			const envelope = z
				.object({
					code: z.union([z.string(), z.number()]),
					msg: z.string().optional(),
					data: z.unknown().optional(),
				})
				.parse(body);
			this.routeFamily = path === corePath ? "core" : "legacy";
			if (status === 200 && Number(envelope.code) === 200) return envelope.data;
			// A repeated request_no is rejected with "The request ID already
			// exists" after the balance was already charged, so it must follow
			// the uncertain path instead of a plain failure that invites a new
			// number.
			if (envelope.msg?.includes("already exists"))
				throw new DomainError(
					"supplier_request_uncertain",
					502,
					"Supplier request outcome is uncertain",
				);
			throw new DomainError(
				"supplier_request_failed",
				502,
				"Supplier request failed",
			);
		}
		throw lastError;
	}
}

function commoditySkus(
	commodity: z.infer<typeof commoditySchema>,
	currencyDecimals: number,
): SupplierSku[] {
	const config = sharedConfig(commodity.config);
	const prices = Object.keys(config.category).length
		? config.category
		: config.categoryFactory;
	const variants = Object.entries(prices);
	if (variants.length)
		return variants.map(([race, price]) => ({
			id: encodeSharedSkuId(commodity.code, race),
			name: race,
			costMinor: decimalToMinor(
				String(config.categoryFactory[race] ?? price),
				currencyDecimals,
			),
			stockQuantity: normalizeStock(commodity.stock),
			active: true,
		}));
	return [
		{
			id: commodity.code,
			name: commodity.name,
			costMinor: decimalToMinor(String(commodity.price), currencyDecimals),
			stockQuantity: normalizeStock(commodity.stock),
			active: true,
		},
	];
}

function preferredInventoryCost(
	data: z.infer<typeof inventorySchema>,
	race: string | null,
) {
	const config = sharedConfig(data.config);
	if (race) {
		const variant = config.categoryFactory[race] ?? config.category[race];
		if (variant != null) return variant;
	}
	if (Number(data.factory_price) > 0) return data.factory_price;
	if (Number(data.user_price) > 0) return data.user_price;
	return data.price;
}

function sharedConfig(value: string | Record<string, unknown>) {
	const result: {
		category: Record<string, string | number>;
		categoryFactory: Record<string, string | number>;
	} = { category: {}, categoryFactory: {} };
	if (typeof value !== "string") {
		const category = value.category;
		const factory = value.category_factory;
		if (category && typeof category === "object" && !Array.isArray(category))
			result.category = scalarPriceMap(category as Record<string, unknown>);
		if (factory && typeof factory === "object" && !Array.isArray(factory))
			result.categoryFactory = scalarPriceMap(
				factory as Record<string, unknown>,
			);
		return result;
	}
	let section = "";
	for (const rawLine of value.split(/\r?\n/)) {
		const line = rawLine.trim();
		const heading = /^\[([^\]]+)]$/.exec(line);
		if (heading) {
			section = heading[1] ?? "";
			continue;
		}
		const separator = line.indexOf("=");
		if (separator < 1) continue;
		const key = line.slice(0, separator).trim();
		const price = line.slice(separator + 1).trim();
		if (!key || !/^\d+(?:\.\d+)?$/.test(price)) continue;
		if (section === "category") result.category[key] = price;
		if (section === "category_factory") result.categoryFactory[key] = price;
	}
	return result;
}

function scalarPriceMap(value: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, price]) =>
			typeof price === "string" || typeof price === "number"
				? [[key, price]]
				: [],
		),
	);
}

function encodeSharedSkuId(code: string, race: string) {
	return `${code}::${encodeURIComponent(race)}`;
}

function decodeSharedSkuId(value: string) {
	const separator = value.indexOf("::");
	if (separator < 0) return { code: value, race: null };
	const code = value.slice(0, separator);
	try {
		return {
			code,
			race: decodeURIComponent(value.slice(separator + 2)),
		};
	} catch {
		return { code, race: null };
	}
}

function notFound() {
	return new DomainError(
		"supplier_sku_not_found",
		404,
		"Supplier SKU was not found",
	);
}

function normalizeStock(value: string | number | null) {
	if (value == null || value === -1 || value === "-1") return 2_147_483_647;
	const parsed = typeof value === "number" ? value : Number(value);
	if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
	throw new DomainError(
		"invalid_supplier_response",
		502,
		"Supplier returned invalid stock",
	);
}

function parseCards(value: string) {
	const cards = value
		.split(/\r?\n/)
		.map((item) => item.trim())
		.filter(Boolean);
	if (cards.length > 10_000 || cards.some((card) => card.length > 64_000))
		throw new DomainError(
			"invalid_supplier_response",
			502,
			"Supplier returned invalid fulfillment",
		);
	return cards;
}
