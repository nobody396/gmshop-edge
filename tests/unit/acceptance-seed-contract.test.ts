import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
	alipayCredentialSchema,
	cryptomusCredentialSchema,
	epayCredentialSchema,
	gmpayCredentialSchema,
	paymentProviderValues,
	stripeCredentialSchema,
	wechatCredentialSchema,
} from "#/features/shop-payments/provider";

const seedSourceUrl = new URL(
	"../../scripts/seed-acceptance.ts",
	import.meta.url,
);
const packageUrl = new URL("../../package.json", import.meta.url);
const commerceSchemaUrl = new URL(
	"../../src/db/schema/commerce.ts",
	import.meta.url,
);
const storefrontFunctionsUrl = new URL(
	"../../src/features/storefront/server/functions.ts",
	import.meta.url,
);
const paymentServiceUrl = new URL(
	"../../src/features/shop-payments/server/service.ts",
	import.meta.url,
);

type AcceptancePaymentChannel = {
	provider: (typeof paymentProviderValues)[number];
	currency: string;
	defaultToken: string;
	defaultNetwork: string;
	credential: unknown;
	feeBps: number;
	fixedFeeMinor: string;
	sortOrder: number;
};

describe("local acceptance seed contract", () => {
	it("is explicit, local-only, and idempotent without destructive cleanup", async () => {
		const source = await readFile(seedSourceUrl, "utf8");

		expect(source).toContain('includes("--local")');
		expect(source).toContain('includes("--remote")');
		expect(source).not.toMatch(/\bDELETE\s+FROM\b/i);
		expect(source).toContain("ON CONFLICT");
	});

	it("covers every delivery method without mixing types in one product", async () => {
		const source = await readFile(seedSourceUrl, "utf8");

		for (const type of ["stock", "download", "automation"])
			expect(source).toContain(`"${type}"`);
		expect(source).not.toContain("本地验收");
		expect(source).toContain("sellableItem(61, 1, 61");
		expect(source).toContain("sellableItem(57, 2, 57");
		expect(source).toContain("sellableItem(75, 3, 75");
		expect(source).toContain("sellableItem(81, 4, 81");
		for (const policy of ["none", "optional", "required"])
			expect(source).toContain(`"${policy}"`);
	});

	it("upserts product tag names without the removed tag tables", async () => {
		const source = await readFile(seedSourceUrl, "utf8");

		expect(source).toMatch(
			/INSERT INTO products[\s\S]*?tag_names[\s\S]*?ON CONFLICT\(id\) DO UPDATE SET[\s\S]*?tag_names = excluded\.tag_names/,
		);
		expect(source).not.toContain("product_tags");
		expect(source).not.toContain("product_tag_links");
	});

	it("exposes one local seed command for acceptance, R2, and Telegram fixtures", async () => {
		const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
			scripts: Record<string, string>;
		};

		expect(packageJson.scripts["seed:local"]).toBe(
			"bun run scripts/seed-acceptance.ts --local --with-r2",
		);
		expect(
			Object.keys(packageJson.scripts).filter((key) => key.startsWith("seed:")),
		).toEqual(["seed:local"]);
		expect(await readFile(seedSourceUrl, "utf8")).toContain(
			"seedTelegramMiniAppUser",
		);
	});

	it("seeds the Telegram fixture directly without a running app server", async () => {
		const source = await readFile(seedSourceUrl, "utf8");

		expect(source).not.toContain("await fetch(");
		expect(source).not.toContain("runtime.better_auth_url");
		expect(source).toContain("INSERT INTO users");
		expect(source).toContain("INSERT INTO accounts");
		expect(source).toContain("ON CONFLICT(provider_id, account_id)");
	});

	it("provides enabled local payment channels with encrypted fake credentials", async () => {
		const source = await readFile(seedSourceUrl, "utf8");
		const channels = await readPaymentChannels(source);

		expect(channels.map((channel) => channel.provider)).toEqual([
			"gmpay",
			"epay",
			"stripe",
			"cryptomus",
			"alipay_page",
			"alipay_wap",
			"wechat_native",
			"wechat_h5",
			"alipay_qr",
		]);
		expect(new Set(channels.map((channel) => channel.provider))).toEqual(
			new Set(paymentProviderValues),
		);
		for (const channel of channels) {
			expect(channel.feeBps).toBeGreaterThanOrEqual(0);
			expect(channel.feeBps).toBeLessThanOrEqual(10_000);
			expect(channel.fixedFeeMinor).toMatch(/^(0|[1-9]\d*)$/);
			expect(Boolean(channel.defaultToken)).toBe(
				Boolean(channel.defaultNetwork),
			);
			credentialSchema(channel.provider).parse(channel.credential);
			if (
				channel.provider === "alipay_page" ||
				channel.provider === "alipay_wap" ||
				channel.provider === "alipay_qr" ||
				channel.provider === "wechat_native" ||
				channel.provider === "wechat_h5"
			)
				expect(channel.currency).toBe("CNY");
		}
		expect(source).toContain('"payment-credential"');
		expect(source).toContain("INSERT INTO payment_channels");
		expect(source).toContain("1, 'unknown'");
		expect(source).toContain("payments.example.invalid");
	});

	it("keeps payment fixtures compatible with D1 and checkout visibility", async () => {
		const [seedSource, commerceSchema, storefrontFunctions, paymentService] =
			await Promise.all([
				readFile(seedSourceUrl, "utf8"),
				readFile(commerceSchemaUrl, "utf8"),
				readFile(storefrontFunctionsUrl, "utf8"),
				readFile(paymentServiceUrl, "utf8"),
			]);

		expect(commerceSchema).toContain("payment_channels_default_asset_check");
		expect(commerceSchema).toContain("payment_channels_credential_shape_check");
		expect(seedSource).toMatch(
			/credential_encrypted,\s*credential_key_version[\s\S]*?\)\s*VALUES[\s\S]*?\n\s*1,\s*\$\{channel\.feeBps\}/,
		);
		expect(seedSource).toMatch(
			/\$\{channel\.sortOrder\},\s*\n\s*1,\s*'unknown'/,
		);
		expect(storefrontFunctions).toMatch(
			/FROM payment_channels\s+WHERE enabled = 1 ORDER BY sort_order, name, id/,
		);
		expect(paymentService).toMatch(
			/FROM shop_orders o JOIN payment_channels pc ON pc\.id = \?\s+WHERE o\.id = \? AND pc\.enabled = 1 LIMIT 1/,
		);
	});

	it("provides a multi-image gallery for every acceptance product", async () => {
		const source = await readFile(seedSourceUrl, "utf8");

		for (const product of [1, 2, 3, 4, 5, 101]) {
			const mediaCount = source.match(
				new RegExp(`mediaFixture\\(${product},`, "g"),
			)?.length;
			expect(mediaCount).toBe(3);
		}
	});

	it("attaches acceptance ownership to the installed root identity", async () => {
		const source = await readFile(seedSourceUrl, "utf8");

		expect(source).toContain('const customerEmail = "root@example.com"');
		expect(source).toContain('const customerPassword = "root@example.com"');
		expect(source).toContain("await hashPassword(customerPassword)");
		expect(source).toContain("enabled root user");
		expect(source).toContain("fixtureOwners.find");
		expect(source).toContain("customerUserId");
		expect(source).toContain("UPDATE accounts SET password");
		expect(source).toContain("Local root login:");
	});

	it("seeds representative purchased entitlements and immutable histories", async () => {
		const source = await readFile(seedSourceUrl, "utf8");

		expect(source.match(/customerPurchase\(\d/g)).toHaveLength(7);
		for (const status of ["active", "exhausted", "expired"])
			expect(source).toContain(`"${status}"`);
		for (const table of [
			"shop_orders",
			"shop_order_items",
			"customer_entitlements",
			"entitlement_grants",
			"entitlement_events",
			"delivery_records",
			"order_item_download_assets",
			"automation_jobs",
		])
			expect(source).toContain(`INSERT INTO ${table}`);
		expect(source).toContain("Stock customer fixture is required.");
		expect(source).toContain("is not exhausted.");
		expect(source).toContain("is not expired.");
		expect(source).toContain("'delivered'");
		expect(source).toContain("'downloaded'");
		expect(source).toContain("'consumed'");
	});

	it("provides runnable automation definitions, authorization values, and history", async () => {
		const source = await readFile(seedSourceUrl, "utf8");

		for (const inputType of ["text", "select", "boolean"])
			expect(source).toContain(`inputType: "${inputType}"`);
		expect(source).toContain('key: "dry_run"');
		expect(source).toContain('exampleValue: "true"');
		expect(source).toContain("INSERT INTO entitlement_authorization_values");
		expect(source).toContain('"succeeded"');
		expect(source).toContain('"failed"');
		expect(source).toContain("INSERT INTO automation_artifacts");
		expect(source).toContain("demo-build.zip");
	});

	it("provides inert supplier accounts, bindings, orders, and sync settings", async () => {
		const source = await readFile(seedSourceUrl, "utf8");

		expect(source).toContain("createSupplierCredentialVault");
		expect(source).toContain("supplierCredentialFingerprint");
		expect(source).toContain("acg.example.invalid");
		expect(source).toContain("dujiao.example.invalid");
		expect(source).toContain('"3.5.5-v4"');
		expect(source).toContain('"1.3.1-upstream-v1"');
		for (const table of [
			"supplier_accounts",
			"supplier_bindings",
			"supplier_orders",
		])
			expect(source).toContain(`INSERT INTO ${table}`);
		for (const state of ["supplied", "uncertain", "failed"])
			expect(source).toContain(`state: "${state}"`);
		expect(source).toContain(
			"JSON.stringify({ enabled: false, intervalMs: 600_000 })",
		);
		expect(source).toContain("enabled = 0");
		expect(source).toContain("supplierCatalogFixtures");
		expect(source).toContain("putKvValue");
		expect(source).toContain("demo-acg-sku-premium");
		expect(source).toContain("demo-dujiao-sku-year");
	});
});

function credentialSchema(provider: AcceptancePaymentChannel["provider"]) {
	if (provider === "stripe") return stripeCredentialSchema;
	if (provider === "cryptomus") return cryptomusCredentialSchema;
	if (provider === "gmpay") return gmpayCredentialSchema;
	if (provider === "epay") return epayCredentialSchema;
	if (
		provider === "alipay_page" ||
		provider === "alipay_wap" ||
		provider === "alipay_qr"
	)
		return alipayCredentialSchema;
	return wechatCredentialSchema;
}

async function readPaymentChannels(source: string) {
	const executableSource = [
		sourceSection(source, "const paymentChannels =", "] as const;"),
		sourceSection(
			source,
			"function alipayCredential(",
			"\nfunction wechatCredential(",
		),
		sourceSection(source, "function wechatCredential(", "\nfunction uuid("),
		sourceSection(source, "function uuid(", "\nfunction q("),
		"return paymentChannels;",
	].join("\n");
	const transpiled = ts.transpileModule(executableSource, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	return new Function(transpiled)() as AcceptancePaymentChannel[];
}

function sourceSection(source: string, startMarker: string, endMarker: string) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start);
	if (start < 0 || end < 0)
		throw new Error(`Acceptance seed section not found: ${startMarker}`);
	return source.slice(
		start,
		end + (endMarker === "] as const;" ? endMarker.length : 0),
	);
}
