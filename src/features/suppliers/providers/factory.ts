import {
	acgCredentialsSchema,
	dujiaoNextCredentialsSchema,
	gmshopEdgeCredentialsSchema,
	type SupplierProvider,
	sharedStockCredentialsSchema,
} from "../schema";
import type { SupplierCredentials } from "../secrets";
import { AcgAdapter } from "./acg";
import { DujiaoNextAdapter } from "./dujiao-next";
import { GmshopEdgeAdapter } from "./gmshop-edge";
import type { SupplierHttpAudit } from "./http";
import { SharedStockAdapter } from "./shared-stock";
import type { SupplierAdapter } from "./types";

export function createSupplierAdapter(input: {
	provider: SupplierProvider;
	baseUrl: string;
	credentials: SupplierCredentials;
	currency: string;
	currencyDecimals: number;
	fetcher?: typeof fetch;
	audit?: SupplierHttpAudit;
}): SupplierAdapter {
	if (input.provider === "acg") {
		const credentials = acgCredentialsSchema.parse(input.credentials);
		return new AcgAdapter({
			baseUrl: input.baseUrl,
			apiId: credentials.apiId,
			appKey: credentials.appKey,
			currency: input.currency,
			currencyDecimals: input.currencyDecimals,
			fetcher: input.fetcher,
			audit: input.audit,
		});
	}
	if (input.provider === "dujiao_next") {
		const credentials = dujiaoNextCredentialsSchema.parse(input.credentials);
		return new DujiaoNextAdapter({
			baseUrl: input.baseUrl,
			apiKey: credentials.apiKey,
			apiSecret: credentials.apiSecret,
			currency: input.currency,
			currencyDecimals: input.currencyDecimals,
			fetcher: input.fetcher,
			audit: input.audit,
		});
	}
	if (input.provider === "shared_stock") {
		const credentials = sharedStockCredentialsSchema.parse(input.credentials);
		return new SharedStockAdapter({
			baseUrl: input.baseUrl,
			appId: credentials.appId,
			appKey: credentials.appKey,
			currency: input.currency,
			currencyDecimals: input.currencyDecimals,
			fetcher: input.fetcher,
			audit: input.audit,
		});
	}
	const credentials = gmshopEdgeCredentialsSchema.parse(input.credentials);
	return new GmshopEdgeAdapter({
		baseUrl: input.baseUrl,
		apiKey: credentials.apiKey,
		apiSecret: credentials.apiSecret,
		currency: input.currency,
		currencyDecimals: input.currencyDecimals,
		fetcher: input.fetcher,
		audit: input.audit,
	});
}
