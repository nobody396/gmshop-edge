import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireStorefrontPermission } from "#/features/access/storefront-access";
import { getDb } from "#/server/db.server";
import { getStoreSessionUser } from "./account";
import { loadItemPricing } from "./item-pricing";
import { quoteUnitPrices } from "./price-quote";

const unitPriceQuoteSchema = z.object({
	items: z
		.array(
			z.object({ id: z.uuid(), quantity: z.number().int().min(1).max(1000) }),
		)
		.min(1)
		.max(100),
});

/** What each checkout line costs at its quantity, with the signed-in customer's own prices. */
export const quoteCheckoutUnitPricesFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof unitPriceQuoteSchema>) =>
		unitPriceQuoteSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireStorefrontPermission("guest", "catalog.read");
		const user = await getStoreSessionUser(request).catch(() => null);
		return quoteUnitPrices(
			getDb(request).$client,
			data.items,
			user?.id ?? null,
		);
	});

const productPricingSchema = z.object({
	sellableItemIds: z.array(z.uuid()).min(1).max(100),
});

/** Volume steps of a product's plans, plus the signed-in customer's own prices. */
export const getProductPricingFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productPricingSchema>) =>
		productPricingSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireStorefrontPermission("guest", "catalog.read");
		const user = await getStoreSessionUser(request).catch(() => null);
		const pricing = await loadItemPricing(
			getDb(request).$client,
			data.sellableItemIds,
			user?.id ?? null,
		);
		return Object.fromEntries(pricing);
	});
