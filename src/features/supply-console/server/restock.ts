import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { normalizeInventorySecrets } from "#/features/catalog/server/inventory-secrets";
import { importRestockBatch } from "#/features/catalog/server/restock-api";
import { quickRestockRedeemWarehouse } from "#/features/redeem-warehouse/server/admin";
import { requestWarehouse } from "#/features/redeem-warehouse/server/warehouse-client";
import { DomainError } from "#/lib/domain-error";
import { decimalToMinor } from "#/lib/units";
import { getAdminRuntimeServerContext } from "#/server/context";
import { loadSupplyMap } from "./query";

const restockSchema = z.object({
	requestRef: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_-]{16,100}$/),
	componentId: z.uuid(),
	unitCostYuan: z
		.string()
		.trim()
		.regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/),
	content: z.string().trim().min(1).max(250_000),
	usageUrl: z.string().trim().max(2_048).optional(),
});

// One restock entry for every SKU. The stored map decides whether the keys
// belong in the central vault (customers redeem our own codes) or straight in
// storefront stock (customers receive the upstream card).
export const restockSupplyFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof restockSchema>) =>
		restockSchema.parse(input),
	)
	.handler(async ({ data }) =>
		restockSupply(
			data,
			await getAdminRuntimeServerContext(
				systemPermission("inventory", "create"),
			),
		),
	);

export async function restockSupply(
	data: z.infer<typeof restockSchema>,
	context: Awaited<ReturnType<typeof getAdminRuntimeServerContext>>,
	requester: typeof requestWarehouse = requestWarehouse,
) {
	const centralSku = (await loadSupplyMap(context.db))[data.componentId];
	if (centralSku)
		return {
			route: "central" as const,
			...(await quickRestockRedeemWarehouse(
				{
					requestRef: data.requestRef,
					sku: centralSku,
					componentId: data.componentId,
					unitCostYuan: data.unitCostYuan,
					content: data.content,
				},
				context,
				requester,
			)),
		};
	if (!data.usageUrl)
		throw new DomainError(
			"supply_usage_url_required",
			400,
			"Usage URL is required for direct card stock",
		);
	const secrets = normalizeInventorySecrets(data.content);
	if (!secrets.length)
		throw new DomainError("restock_invalid", 400, "No keys supplied");
	const result = await importRestockBatch(context.db, context.request, {
		requestRef: data.requestRef,
		componentId: data.componentId,
		secrets,
		usageUrl: data.usageUrl,
		source: "manual",
		unitCostMinor: decimalToMinor(data.unitCostYuan, 2).toString(),
	});
	return {
		route: "direct" as const,
		total: secrets.length,
		imported: result.imported,
		counts: { available: result.imported },
		generated: result.imported,
		generationFailed: false,
	};
}
