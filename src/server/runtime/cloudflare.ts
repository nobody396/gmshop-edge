import type { RuntimeEnv } from "#/server/runtime/types";

export type CloudflareBindings = {
	AGENT_ACCESS_SIGNING_KEY?: string;
	AGENT_SHOP_PROGRAM_TOKEN?: string;
	AGENT_PROGRAM_PROFIT_TOKEN?: string;
	DB?: D1Database;
	FILES?: R2Bucket;
	CACHE?: KVNamespace;
	COMMERCE_QUEUE?: Queue;
	EMAIL?: SendEmail;
	RESTOCK_API_TOKEN?: string;
	IPROYAL_API_TOKEN?: string;
	SUPPLIER_ALERT_TOKEN?: string;
	SUPPLIER_TOPUP_RUNNER_TOKEN?: string;
	INVOICE_LOOKUP_TOKEN?: string;
	GMSHOP_EDGEONE_ORIGIN_VERIFY?: string;
	INDEXNOW_KEY?: string;
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
};

export function adaptCloudflareEnv(
	bindings: CloudflareBindings,
	waitUntil?: (promise: Promise<unknown>) => void,
): RuntimeEnv {
	const database = bindings.DB as RuntimeEnv["DB"];
	return {
		runtime: "cloudflare",
		AGENT_ACCESS_SIGNING_KEY: bindings.AGENT_ACCESS_SIGNING_KEY,
		AGENT_SHOP_PROGRAM_TOKEN: bindings.AGENT_SHOP_PROGRAM_TOKEN,
		AGENT_PROGRAM_PROFIT_TOKEN: bindings.AGENT_PROGRAM_PROFIT_TOKEN,
		DB: database,
		FILES: bindings.FILES as RuntimeEnv["FILES"],
		CACHE: bindings.CACHE as RuntimeEnv["CACHE"],
		COMMERCE_QUEUE: bindings.COMMERCE_QUEUE as RuntimeEnv["COMMERCE_QUEUE"],
		EMAIL: bindings.EMAIL,
		RESTOCK_API_TOKEN: bindings.RESTOCK_API_TOKEN,
		IPROYAL_API_TOKEN: bindings.IPROYAL_API_TOKEN,
		SUPPLIER_ALERT_TOKEN: bindings.SUPPLIER_ALERT_TOKEN,
		SUPPLIER_TOPUP_RUNNER_TOKEN: bindings.SUPPLIER_TOPUP_RUNNER_TOKEN,
		INVOICE_LOOKUP_TOKEN: bindings.INVOICE_LOOKUP_TOKEN,
		GMSHOP_EDGEONE_ORIGIN_VERIFY: bindings.GMSHOP_EDGEONE_ORIGIN_VERIFY,
		INDEXNOW_KEY: bindings.INDEXNOW_KEY,
		TURNSTILE_SITE_KEY: bindings.TURNSTILE_SITE_KEY,
		TURNSTILE_SECRET_KEY: bindings.TURNSTILE_SECRET_KEY,
		waitUntil,
	};
}
