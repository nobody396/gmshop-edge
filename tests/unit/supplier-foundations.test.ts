import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decimalToMinor,
	markupMinor,
	multiplyMinor,
} from "#/features/suppliers/money";
import { AcgAdapter } from "#/features/suppliers/providers/acg";
import { DujiaoNextAdapter } from "#/features/suppliers/providers/dujiao-next";
import { GmshopEdgeAdapter } from "#/features/suppliers/providers/gmshop-edge";
import { SharedStockAdapter } from "#/features/suppliers/providers/shared-stock";
import {
	providerRequestNumber,
	signAcgForm,
	signDujiaoNextRequest,
	signSharedStockForm,
} from "#/features/suppliers/providers/signatures";
import {
	createSupplierCredentialVault,
	readSupplierCredentials,
	rotateSupplierCredentialVault,
	supplierCredentialFingerprint,
} from "#/features/suppliers/secrets";
import { assertPublicSupplierHostname } from "#/features/suppliers/server/destination-security";
import {
	normalizeSupplierSource,
	sameSupplierSource,
} from "#/features/suppliers/server/source-url";
import { createSecretKeyring } from "#/lib/secrets";

describe("supplier source identity", () => {
	it("normalizes equivalent HTTPS origins without a persisted source key", () => {
		const left = normalizeSupplierSource("acg", "https://SHOP.example.com/");
		const right = normalizeSupplierSource(
			"acg",
			"https://shop.example.com:443",
		);
		expect(left).toEqual({
			provider: "acg",
			baseUrl: "https://shop.example.com",
			normalizedApiOrigin: "https://shop.example.com",
			protocolVersion: "3.5.5-v4",
		});
		expect(sameSupplierSource(left, right)).toBe(true);
	});

	it.each([
		"http://shop.example.com",
		"https://user:secret@shop.example.com",
		"https://shop.example.com/path",
		"https://shop.example.com?query=1",
		"https://127.0.0.1",
		"https://localhost",
		"https://shop.example.com:8443",
	])("rejects unsafe or non-origin URL %s", (value) => {
		expect(() => normalizeSupplierSource("dujiao_next", value)).toThrow(
			"Supplier API URL must be a public HTTPS origin",
		);
	});
});

describe("supplier destination DNS", () => {
	it("accepts a hostname only when every answer is public", async () => {
		await expect(
			assertPublicSupplierHostname("supplier.example", async (_host, type) =>
				type === "A" ? ["8.8.8.8"] : ["2606:4700:4700::1111"],
			),
		).resolves.toBeUndefined();
	});

	it.each([
		"127.0.0.1",
		"10.0.0.1",
		"169.254.1.1",
		"192.168.1.1",
		"::1",
		"fd00::1",
	])("rejects a hostname resolving to private address %s", async (address) => {
		await expect(
			assertPublicSupplierHostname("supplier.example", async (_host, type) =>
				(type === "A") === address.includes(".") ? [address] : [],
			),
		).rejects.toMatchObject({ code: "supplier_destination_rejected" });
	});

	it("rejects DNS rebinding when any answer becomes private", async () => {
		await expect(
			assertPublicSupplierHostname("supplier.example", async (_host, type) =>
				type === "A" ? ["8.8.8.8", "10.0.0.8"] : [],
			),
		).rejects.toMatchObject({ code: "supplier_destination_rejected" });
	});
});

describe("supplier provider signatures", () => {
	it("connects to a native GMShop Edge supplier with signed requests", async () => {
		const adapter = new GmshopEdgeAdapter({
			baseUrl: "https://supplier.example",
			apiKey: "gme_test",
			apiSecret: "a".repeat(64),
			currency: "USD",
			currencyDecimals: 2,
			now: () => 1_700_000_000_000,
			nonce: () => "00000000-0000-4000-8000-000000000001",
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				expect(request.headers.get("GMShop-Edge-Api-Key")).toBe("gme_test");
				expect(request.headers.get("GMShop-Edge-Signature")).toMatch(
					/^[a-f0-9]{64}$/,
				);
				return Response.json({
					site_name: "Upstream",
					balance_minor: "1234",
					currency: "USD",
				});
			},
		});
		expect(await adapter.testConnection()).toEqual({
			siteName: "Upstream",
			balance: { amountMinor: "1234", currency: "USD" },
		});
	});
	it("sorts non-empty ACG fields and appends the key", () => {
		const expected = createHash("md5")
			.update("quantity=2&sku_id=sku-1&trade_no=trade-1&key=secret")
			.digest("hex");
		expect(
			signAcgForm(
				{
					trade_no: "trade-1",
					ignored: "",
					sku_id: "sku-1",
					quantity: "2",
				},
				"secret",
			),
		).toBe(expected);
	});

	it("signs the exact Dujiao Next request payload", () => {
		const rawBody = '{"sku_id":"sku-1","quantity":2}';
		const timestamp = "1784935000";
		const bodyMd5 = createHash("md5").update(rawBody).digest("hex");
		const payload = `POST\n/api/v1/upstream/orders\n${timestamp}\n${bodyMd5}`;
		const expected = createHmac("sha256", "secret")
			.update(payload)
			.digest("hex");
		expect(
			signDujiaoNextRequest({
				method: "post",
				path: "/api/v1/upstream/orders",
				timestamp,
				rawBody,
				apiSecret: "secret",
			}),
		).toBe(expected);
	});

	it("derives stable account-scoped request numbers", () => {
		const acg = providerRequestNumber("acg", "order-1", "account-a");
		expect(acg).toHaveLength(24);
		expect(providerRequestNumber("acg", "order-1", "account-a")).toBe(acg);
		expect(providerRequestNumber("acg", "order-1", "account-b")).not.toBe(acg);
		expect(
			providerRequestNumber("dujiao_next", "order-1", "account-a"),
		).toMatch(/^gm_[a-f0-9]{40}$/);
		expect(
			providerRequestNumber("shared_stock", "order-1", "account-a"),
		).toMatch(/^[a-f0-9]{19}$/);
	});

	it("fits SharedStock request_no into the upstream CHAR(19) contract", () => {
		const value = providerRequestNumber("shared_stock", "order-1", "account-a");
		expect(value).toMatch(/^[a-f0-9]{19}$/);
		expect(providerRequestNumber("shared_stock", "order-1", "account-a")).toBe(
			value,
		);
		expect(
			providerRequestNumber("shared_stock", "order-1", "account-b"),
		).not.toBe(value);
		expect(
			providerRequestNumber("shared_stock", "order-2", "account-a"),
		).not.toBe(value);
	});

	it("signs SharedStock forms the way acg-faka SharedValidation does", () => {
		const expected = createHash("md5")
			.update("app_id=10001&code=GPT-1&num=2&key=secret")
			.digest("hex");
		expect(
			signSharedStockForm(
				{
					sign: "forged",
					num: "2",
					code: "GPT-1",
					ignored: "",
					app_id: "10001",
				},
				"secret",
			),
		).toBe(expected);
	});
});

describe("supplier money", () => {
	it("converts decimal wire amounts without floating point", () => {
		expect(decimalToMinor("12.34", 2)).toBe("1234");
		expect(decimalToMinor("12", 2)).toBe("1200");
		expect(decimalToMinor("0.1", 2)).toBe("10");
		expect(multiplyMinor("900719925474099312345", 3)).toBe(
			"2702159776422297937035",
		);
		expect(markupMinor("101", "7", 500)).toBe("114");
	});

	it.each([
		"-1",
		"1.234",
		"1e2",
		"01",
		"NaN",
	])("rejects invalid provider money %s", (value) => {
		expect(() => decimalToMinor(value, 2)).toThrow(
			"Supplier returned an invalid monetary value",
		);
	});
});

describe("supplier credential vault", () => {
	it("keeps old revisions available for uncertain orders after rotation", async () => {
		const commerceSecret = createSecretKeyring();
		const encrypted = await createSupplierCredentialVault(
			"acg",
			{ apiId: "old-id", appKey: "old-key" },
			commerceSecret,
		);
		const rotated = await rotateSupplierCredentialVault(
			encrypted,
			"acg",
			{ apiId: "new-id", appKey: "new-key" },
			commerceSecret,
		);
		expect(rotated.revision).toBe(2);
		await expect(
			readSupplierCredentials(rotated.encrypted, 1, "acg", commerceSecret),
		).resolves.toEqual({ apiId: "old-id", appKey: "old-key" });
		await expect(
			readSupplierCredentials(rotated.encrypted, 2, "acg", commerceSecret),
		).resolves.toEqual({ apiId: "new-id", appKey: "new-key" });
	});

	it("derives deterministic purpose-separated fingerprints", async () => {
		const commerceSecret = createSecretKeyring();
		const credentials = { apiKey: "key", apiSecret: "secret" };
		const left = await supplierCredentialFingerprint(
			"dujiao_next",
			credentials,
			commerceSecret,
		);
		const right = await supplierCredentialFingerprint(
			"dujiao_next",
			{ apiSecret: "secret", apiKey: "key" },
			commerceSecret,
		);
		expect(left).toBe(right);
		expect(left).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("Dujiao Next adapter", () => {
	it("signs ping and normalizes its balance", async () => {
		let request: Request | undefined;
		const adapter = new DujiaoNextAdapter({
			baseUrl: "https://supplier.example",
			apiKey: "api-key",
			apiSecret: "api-secret",
			currency: "CNY",
			currencyDecimals: 2,
			now: () => 1_784_935_000_000,
			fetcher: async (input, init) => {
				request = new Request(input, init);
				return Response.json({
					ok: true,
					site_name: "Supplier",
					balance: "12.34",
					currency: "CNY",
				});
			},
		});
		await expect(adapter.testConnection()).resolves.toEqual({
			siteName: "Supplier",
			balance: { amountMinor: "1234", currency: "CNY" },
		});
		expect(request?.url).toBe("https://supplier.example/api/v1/upstream/ping");
		expect(request?.headers.get("Dujiao-Next-Api-Key")).toBe("api-key");
		expect(request?.headers.get("Dujiao-Next-Timestamp")).toBe("1784935000");
		expect(request?.headers.get("Dujiao-Next-Signature")).toBe(
			signDujiaoNextRequest({
				method: "POST",
				path: "/api/v1/upstream/ping",
				timestamp: "1784935000",
				rawBody: "",
				apiSecret: "api-secret",
			}),
		);
	});

	it("normalizes localized products and unlimited stock", async () => {
		const adapter = new DujiaoNextAdapter({
			baseUrl: "https://supplier.example",
			apiKey: "key",
			apiSecret: "secret",
			currency: "CNY",
			currencyDecimals: 2,
			fetcher: async (input) =>
				new URL(String(input)).pathname.endsWith("/categories")
					? Response.json({ ok: true, categories: [] })
					: Response.json({
							total: 1,
							items: [
								{
									id: 3,
									title: { "en-US": "English", "zh-CN": "中文" },
									description: { "en-US": "Description" },
									images: [],
									tags: ["Tag"],
									currency: "CNY",
									is_active: true,
									skus: [
										{
											id: 9,
											sku_code: "SKU",
											spec_values: {},
											price_amount: "8.50",
											stock_quantity: -1,
											is_active: true,
										},
									],
								},
							],
						}),
		});
		await expect(
			adapter.listProducts({ page: 1, pageSize: 20 }),
		).resolves.toEqual({
			total: 1,
			products: [
				{
					id: "3",
					name: "中文",
					description: "Description",
					imageUrls: [],
					categoryNames: ["Tag"],
					active: true,
					skus: [
						{
							id: "9",
							name: "SKU",
							costMinor: "850",
							stockQuantity: 2_147_483_647,
							active: true,
						},
					],
				},
			],
		});
	});
});

describe("ACG adapter", () => {
	it("uses V4 headers and normalizes its catalog", async () => {
		const requests: Request[] = [];
		const adapter = new AcgAdapter({
			baseUrl: "https://supplier.example",
			apiId: "api-id",
			appKey: "app-key",
			currency: "CNY",
			currencyDecimals: 2,
			fetcher: async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json({
					code: 200,
					data: [
						{
							id: 1,
							name: "Product",
							introduce: "Description",
							picture_url: "https://supplier.example/image.png",
							category: { name: "Category" },
							sku: [
								{
									id: 2,
									name: "SKU",
									stock_price: "3.50",
									stock: "9",
								},
							],
						},
					],
				});
			},
		});
		await expect(
			adapter.listProducts({ page: 1, pageSize: 20 }),
		).resolves.toMatchObject({
			total: 1,
			products: [
				{
					id: "1",
					name: "Product",
					categoryNames: ["Category"],
					skus: [{ id: "2", costMinor: "350", stockQuantity: 9 }],
				},
			],
		});
		expect(requests[0]?.headers.get("Api-Id")).toBe("api-id");
		expect(requests[0]?.headers.get("Api-Signature")).toBe(
			signAcgForm({}, "app-key"),
		);
		expect(requests[0]?.redirect).toBe("manual");
	});

	it("reuses the trade number when reconciling", async () => {
		const bodies: string[] = [];
		const adapter = new AcgAdapter({
			baseUrl: "https://supplier.example",
			apiId: "api-id",
			appKey: "app-key",
			currency: "CNY",
			currencyDecimals: 2,
			fetcher: async (_input, init) => {
				bodies.push(String(init?.body));
				return Response.json({
					code: 200,
					data: { contents: "CARD-1\nCARD-2" },
				});
			},
		});
		await expect(
			adapter.reconcileOrder({
				upstreamOrderId: "trade-123",
				skuId: "2",
				quantity: 2,
				requestNo: "trade-123",
				callbackUrl: "",
				traceId: "",
			}),
		).resolves.toMatchObject({
			status: "supplied",
			upstreamOrderId: "trade-123",
			cards: ["CARD-1", "CARD-2"],
		});
		expect(bodies[0]).toContain("trade_no=trade-123");
	});
});

describe("SharedStock adapter", () => {
	function adapterWith(responses: (input: Request) => unknown) {
		const requests: Request[] = [];
		const adapter = new SharedStockAdapter({
			baseUrl: "https://supplier.example",
			appId: "10001",
			appKey: "secret",
			currency: "CNY",
			currencyDecimals: 2,
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				return Response.json(responses(request));
			},
		});
		return { adapter, requests };
	}

	it("signs the connect form body and normalizes the balance", async () => {
		const { adapter, requests } = adapterWith(() => ({
			code: 200,
			msg: "success",
			data: { shopName: "上游店铺", balance: "88.50" },
		}));
		await expect(adapter.testConnection()).resolves.toEqual({
			siteName: "上游店铺",
			balance: { amountMinor: "8850", currency: "CNY" },
		});
		const request = requests[0];
		expect(request?.url).toBe(
			"https://supplier.example/shared/authentication/connect",
		);
		const body = new URLSearchParams(await request?.text());
		expect(body.get("app_id")).toBe("10001");
		expect(body.get("sign")).toBe(
			signSharedStockForm({ app_id: "10001" }, "secret"),
		);
	});

	it("falls back to the legacy SharedStock plugin when core routes are absent", async () => {
		const urls: string[] = [];
		const adapter = new SharedStockAdapter({
			baseUrl: "https://supplier.example",
			appId: "10001",
			appKey: "secret",
			currency: "CNY",
			currencyDecimals: 2,
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				urls.push(request.url);
				const path = new URL(request.url).pathname;
				return path.startsWith("/shared/")
					? new Response("<!doctype html><title>当前插件未启用</title>", {
							status: 200,
							headers: { "Content-Type": "text/html" },
						})
					: Response.json({
							code: 200,
							msg: "success",
							data: path.endsWith("/items")
								? []
								: { shopName: "旧版上游", balance: "10.00" },
						});
			},
		});
		await expect(adapter.testConnection()).resolves.toEqual({
			siteName: "旧版上游",
			balance: { amountMinor: "1000", currency: "CNY" },
		});
		expect(urls[0]).toBe(
			"https://supplier.example/shared/authentication/connect",
		);
		expect(urls[1]).toBe(
			"https://supplier.example/plugin/SharedStock/api/connect",
		);
		await expect(
			adapter.listProducts({ page: 1, pageSize: 20 }),
		).resolves.toEqual({ total: 0, products: [] });
		expect(urls[2]).toBe(
			"https://supplier.example/plugin/SharedStock/api/items",
		);
	});

	it("flattens the shared category tree into code-keyed products", async () => {
		const { adapter } = adapterWith(() => ({
			code: 200,
			data: [
				{
					id: 1,
					name: "会员专区",
					children: [
						{
							id: 11,
							code: "GPT-PLUS",
							name: "GPT Plus 代开",
							description: "描述",
							cover: "/assets/cache/general/cover.jpg",
							price: "99.00",
							stock: "7",
						},
					],
				},
				{ id: 2, name: "空分类", children: [] },
			],
		}));
		await expect(
			adapter.listProducts({ page: 1, pageSize: 20 }),
		).resolves.toEqual({
			total: 1,
			products: [
				{
					id: "GPT-PLUS",
					name: "GPT Plus 代开",
					description: "描述",
					imageUrls: [
						"https://supplier.example/assets/cache/general/cover.jpg",
					],
					categoryNames: ["会员专区"],
					active: true,
					skus: [
						{
							id: "GPT-PLUS",
							name: "GPT Plus 代开",
							costMinor: "9900",
							stockQuantity: 7,
							active: true,
						},
					],
				},
			],
		});
	});

	it("exposes INI category prices as independently purchasable shared SKUs", async () => {
		const { adapter } = adapterWith(() => ({
			code: 200,
			data: [
				{
					id: 7,
					name: "ChatGPT",
					children: [
						{
							id: 69,
							code: "CODEX-CREDIT",
							name: "Codex 点数",
							description: "描述",
							cover: "",
							price: "75.00",
							stock: "58",
							config:
								"[category]\n250点数额度=75\n500点数额度=145\n1000点数额度=276",
						},
					],
				},
			],
		}));
		const result = await adapter.listProducts({ page: 1, pageSize: 20 });
		expect(result.products[0]?.skus).toEqual([
			{
				id: "CODEX-CREDIT::250%E7%82%B9%E6%95%B0%E9%A2%9D%E5%BA%A6",
				name: "250点数额度",
				costMinor: "7500",
				stockQuantity: 58,
				active: true,
			},
			{
				id: "CODEX-CREDIT::500%E7%82%B9%E6%95%B0%E9%A2%9D%E5%BA%A6",
				name: "500点数额度",
				costMinor: "14500",
				stockQuantity: 58,
				active: true,
			},
			{
				id: "CODEX-CREDIT::1000%E7%82%B9%E6%95%B0%E9%A2%9D%E5%BA%A6",
				name: "1000点数额度",
				costMinor: "27600",
				stockQuantity: 58,
				active: true,
			},
		]);
	});

	it("prefers the factory price when reading a sku", async () => {
		const { adapter, requests } = adapterWith(() => ({
			code: 200,
			data: {
				count: 12,
				delivery_way: 0,
				price: "99.00",
				user_price: "88.00",
				factory_price: "85.50",
			},
		}));
		await expect(adapter.getSku("GPT-PLUS", "GPT-PLUS")).resolves.toEqual({
			id: "GPT-PLUS",
			name: "GPT-PLUS",
			costMinor: "8550",
			stockQuantity: 12,
			active: true,
		});
		const body = new URLSearchParams(await requests[0]?.text());
		expect(body.get("sharedCode")).toBe("GPT-PLUS");
	});

	it("checks category stock and valuation before purchasing a shared variant", async () => {
		const { adapter, requests } = adapterWith((request) => {
			const path = new URL(request.url).pathname;
			return path.endsWith("/valuation")
				? { code: 200, data: { price: "145.00" } }
				: {
						code: 200,
						data: {
							count: 16,
							delivery_way: 0,
							price: "75.00",
							user_price: "75.00",
							factory_price: "0",
							config: "[category]\n250点数额度=75",
						},
					};
		});
		const skuId = "CODEX-CREDIT::500%E7%82%B9%E6%95%B0%E9%A2%9D%E5%BA%A6";
		await expect(adapter.getSku("CODEX-CREDIT", skuId)).resolves.toEqual({
			id: skuId,
			name: "500点数额度",
			costMinor: "14500",
			stockQuantity: 16,
			active: true,
		});
		expect(requests).toHaveLength(2);
		const inventory = new URLSearchParams(await requests[0]?.text());
		const valuation = new URLSearchParams(await requests[1]?.text());
		expect(inventory.get("race")).toBe("500点数额度");
		expect(valuation.get("race")).toBe("500点数额度");
		expect(valuation.get("num")).toBe("1");
	});

	it("trades with a request_no and returns delivered cards", async () => {
		const { adapter, requests } = adapterWith(() => ({
			code: 200,
			msg: "success",
			data: {
				url: "https://supplier.example/record",
				amount: "85.50",
				tradeNo: "20260822120000333",
				secret: "账号A----密码A\n账号B----密码B",
				leave_message: "",
				stock: 5,
			},
		}));
		await expect(
			adapter.submitOrder({
				skuId: "GPT-PLUS",
				quantity: 2,
				requestNo: "ss_abc123",
				callbackUrl: "",
				traceId: "",
			}),
		).resolves.toEqual({
			status: "supplied",
			upstreamOrderId: "20260822120000333",
			cards: ["账号A----密码A", "账号B----密码B"],
		});
		const body = new URLSearchParams(await requests[0]?.text());
		expect(body.get("shared_code")).toBe("GPT-PLUS");
		expect(body.get("num")).toBe("2");
		expect(body.get("request_no")).toBe("ss_abc123");
	});

	it("preserves a single multiline supplier delivery without interpreting its fields", async () => {
		const delivery = [
			"GPLUS-EXAMPLE",
			"https://supplier.example/redeem",
			"请按上游交付内容操作",
		].join("\n");
		const { adapter } = adapterWith(() => ({
			code: 200,
			msg: "success",
			data: {
				url: "https://supplier.example/internal-order",
				amount: "115.00",
				tradeNo: "20260902180000111",
				secret: delivery,
			},
		}));

		await expect(
			adapter.submitOrder({
				skuId: "GPT-PLUS",
				quantity: 1,
				requestNo: "ss_single_delivery",
				callbackUrl: "",
				traceId: "",
			}),
		).resolves.toEqual({
			status: "supplied",
			upstreamOrderId: "20260902180000111",
			cards: [delivery],
		});
	});

	it("passes the selected category race when trading a shared variant", async () => {
		const { adapter, requests } = adapterWith(() => ({
			code: 200,
			msg: "success",
			data: {
				url: "",
				amount: "145.00",
				tradeNo: "20260824140000111",
				secret: "CODEX-CDK",
			},
		}));
		await expect(
			adapter.submitOrder({
				skuId: "CODEX-CREDIT::500%E7%82%B9%E6%95%B0%E9%A2%9D%E5%BA%A6",
				quantity: 1,
				requestNo: "ss_codex500",
				callbackUrl: "",
				traceId: "",
			}),
		).resolves.toMatchObject({ status: "supplied", cards: ["CODEX-CDK"] });
		const body = new URLSearchParams(await requests[0]?.text());
		expect(body.get("shared_code")).toBe("CODEX-CREDIT");
		expect(body.get("race")).toBe("500点数额度");
	});

	it("never falls back to another purchase endpoint after a non-JSON trade response", async () => {
		const requests: string[] = [];
		const adapter = new SharedStockAdapter({
			baseUrl: "https://supplier.example",
			appId: "merchant",
			appKey: "test-secret",
			currency: "CNY",
			currencyDecimals: 2,
			fetcher: async (input) => {
				requests.push(String(input));
				return new Response("<html>upstream error</html>", { status: 502 });
			},
		});
		await expect(
			adapter.submitOrder({
				skuId: "PLUS",
				quantity: 1,
				requestNo: "ss_test",
				callbackUrl: "",
				traceId: "",
			}),
		).resolves.toMatchObject({
			status: "uncertain",
			errorCode: "invalid_supplier_response",
		});
		expect(requests).toHaveLength(1);
	});

	it.each([
		{
			name: "invalid trade data",
			body: { code: 200, data: { tradeNo: "trade-123", secret: null } },
			status: 200,
			id: "trade-123",
			error: "invalid_supplier_response",
		},
		{
			name: "missing trade data",
			body: { code: 200, data: {} },
			status: 200,
			id: null,
			error: "invalid_supplier_response",
		},
		{
			name: "server failure",
			body: { code: 0, msg: "failure" },
			status: 503,
			id: null,
			error: "supplier_request_uncertain",
		},
	])("preserves uncertainty after $name", async ({
		body,
		status,
		id,
		error,
	}) => {
		let requests = 0;
		const adapter = new SharedStockAdapter({
			baseUrl: "https://supplier.example",
			appId: "merchant",
			appKey: "test-secret",
			currency: "CNY",
			currencyDecimals: 2,
			fetcher: async () => {
				requests++;
				return Response.json(body, { status });
			},
		});
		await expect(
			adapter.submitOrder({
				skuId: "PLUS",
				quantity: 1,
				requestNo: "ss_test",
				callbackUrl: "",
				traceId: "",
			}),
		).resolves.toEqual({
			status: "uncertain",
			upstreamOrderId: id,
			errorCode: error,
		});
		expect(requests).toBe(1);
	});

	it("still treats a valid application rejection as definitive", async () => {
		const { adapter, requests } = adapterWith(() => ({
			code: 0,
			msg: "Insufficient balance",
		}));
		await expect(
			adapter.submitOrder({
				skuId: "PLUS",
				quantity: 1,
				requestNo: "ss_test",
				callbackUrl: "",
				traceId: "",
			}),
		).rejects.toMatchObject({ code: "supplier_request_failed" });
		expect(requests).toHaveLength(1);
	});

	it("maps a duplicate request_no rejection to the uncertain path", async () => {
		const { adapter } = adapterWith(() => ({
			code: 0,
			msg: "The request ID already exists",
		}));
		await expect(
			adapter.submitOrder({
				skuId: "GPT-PLUS",
				quantity: 1,
				requestNo: "ss_abc123",
				callbackUrl: "",
				traceId: "",
			}),
		).resolves.toMatchObject({
			status: "uncertain",
			errorCode: "supplier_request_uncertain",
		});
	});

	it("reconciles a known upstream order through query", async () => {
		const { adapter, requests } = adapterWith(() => ({
			code: 200,
			data: {
				secret: "CARD-9",
				widget: null,
				status: 1,
			},
		}));
		await expect(
			adapter.reconcileOrder({
				upstreamOrderId: "20260822120000333",
				skuId: "GPT-PLUS",
				quantity: 1,
				requestNo: "ss_abc123",
				callbackUrl: "",
				traceId: "",
			}),
		).resolves.toEqual({
			status: "supplied",
			upstreamOrderId: "20260822120000333",
			cards: ["CARD-9"],
		});
		const body = new URLSearchParams(await requests[0]?.text());
		expect(body.get("tradeNo")).toBe("20260822120000333");
	});

	it("preserves a single multiline delivery returned during reconciliation", async () => {
		const delivery = "GPLUS-EXAMPLE\nhttps://supplier.example/redeem";
		const { adapter } = adapterWith(() => ({
			code: 200,
			data: {
				secret: delivery,
				status: 1,
			},
		}));

		await expect(
			adapter.reconcileOrder({
				upstreamOrderId: "20260902180000222",
				skuId: "GPT-PLUS",
				quantity: 1,
				requestNo: "ss_single_reconcile",
				callbackUrl: "",
				traceId: "",
			}),
		).resolves.toEqual({
			status: "supplied",
			upstreamOrderId: "20260902180000222",
			cards: [delivery],
		});
	});

	it("keeps an order uncertain when the upstream trade number is unknown", async () => {
		const { adapter } = adapterWith(() => ({ code: 200, data: {} }));
		await expect(
			adapter.reconcileOrder({
				upstreamOrderId: null,
				skuId: "GPT-PLUS",
				quantity: 1,
				requestNo: "ss_abc123",
				callbackUrl: "",
				traceId: "",
			}),
		).rejects.toMatchObject({ code: "supplier_request_uncertain" });
	});
});
