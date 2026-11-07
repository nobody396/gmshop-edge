import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireStorefrontPermission } from "#/features/access/storefront-access";
import { DomainError } from "#/lib/domain-error";
import { getDb } from "#/server/db.server";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { upgradeQuoteTokenSchema } from "../schema";
import { loadUpgradeQuote } from "./client";

export const getUpgradeQuoteFn = createServerFn({ method: "POST" })
	.validator((input: { quote: string }) =>
		z.object({ quote: upgradeQuoteTokenSchema }).parse(input),
	)
	.handler(async ({ data }) => {
		requireStorefrontPermission("guest", "catalog.read");
		const db = getDb(getRequest()).$client;
		try {
			return await loadUpgradeQuote(
				db,
				(await loadRuntimeConfig(db)).commerceSecret,
				data.quote,
			);
		} catch (error) {
			if (
				error instanceof DomainError &&
				error.code === "redeem_warehouse_http_404_upgrade.quote_not_found"
			)
				return null;
			throw error;
		}
	});
