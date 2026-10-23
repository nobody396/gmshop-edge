import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { authenticateSupplierApi } from "#/features/supplier-api/server/auth";
import {
	allowSupplierApiUser,
	createSupplierApiKey,
	disallowSupplierApiUser,
	supplierApiUserAllowed,
} from "#/features/supplier-api/server/key-store";
import { signGmshopEdgeRequest } from "#/features/suppliers/providers/signatures";
import { createUser } from "#/features/users/server/users";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("supplier API allowlist", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const request = new Request("https://shop.example/account");
	const secret = createInitialRuntimeConfig(
		"https://shop.example",
	).commerceSecret;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			db
				.prepare(
					"INSERT INTO system_settings(key,value,is_secret,created_at,updated_at) VALUES ('runtime.data_encryption_secret',?,1,1,1)",
				)
				.bind(JSON.stringify(secret)),
			db.prepare(
				"INSERT INTO system_settings(key,value,is_secret,created_at,updated_at) VALUES ('commerce.supplier_api_enabled','true',0,1,1)",
			),
		]);
	});

	afterEach(async () => miniflare.dispose());

	const customer = (email: string) =>
		createUser(drizzle(db, { schema }), {
			name: "Customer",
			email,
			enabled: true,
			password: "current-password",
		});

	const signedCall = (credentials: { apiKey: string; apiSecret: string }) => {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const nonce = crypto.randomUUID();
		return authenticateSupplierApi(
			new Request("https://shop.example/api/supply/v1/products", {
				headers: {
					"GMShop-Edge-Api-Key": credentials.apiKey,
					"GMShop-Edge-Timestamp": timestamp,
					"GMShop-Edge-Nonce": nonce,
					"GMShop-Edge-Signature": signGmshopEdgeRequest({
						method: "GET",
						pathWithQuery: "/api/supply/v1/products",
						timestamp,
						nonce,
						rawBody: "",
						apiSecret: credentials.apiSecret,
					}),
				},
			}),
			db,
			"",
		);
	};

	it("refuses to create a key for an ordinary registered customer", async () => {
		const user = await customer("ordinary@example.com");
		await expect(
			createSupplierApiKey(db, request, user.id, secret, {
				name: "Self-service",
				password: "current-password",
			}),
		).rejects.toMatchObject({ code: "supplier_api_not_allowed", status: 403 });
		const keys = await db
			.prepare("SELECT COUNT(*) AS n FROM supplier_api_keys")
			.first<{ n: number }>();
		expect(keys?.n).toBe(0);
	});

	it("authenticates only while the key owner stays on the allowlist", async () => {
		const user = await customer("partner@example.com");
		await allowSupplierApiUser(db, user.id, { grantedBy: null });
		expect(await supplierApiUserAllowed(db, user.id)).toBe(true);
		const credentials = await createSupplierApiKey(
			db,
			request,
			user.id,
			secret,
			{ name: "Partner", password: "current-password" },
		);
		await expect(signedCall(credentials)).resolves.toMatchObject({
			userId: user.id,
		});
		await disallowSupplierApiUser(db, user.id);
		await expect(signedCall(credentials)).rejects.toMatchObject({
			code: "supplier_api_unauthorized",
			status: 401,
		});
	});

	it("backfills exactly the accounts that hold an unrevoked key", async () => {
		const fresh = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		try {
			const legacy = await fresh.getD1Database("DB");
			await applyMigrations(legacy, "0043_volume_pricing.sql");
			await legacy.batch([
				legacy.prepare(
					"INSERT INTO users(id,name,email,email_verified,enabled) VALUES ('partner','P','p@example.com',1,1),('tester','T','t@example.com',1,1),('nobody','N','n@example.com',1,1)",
				),
				legacy.prepare(
					`INSERT INTO supplier_api_keys(id,user_id,name,key_id,secret_encrypted,revoked_at) VALUES
					 ('k1','partner','Live','gme_live','x',NULL),
					 ('k2','partner','Spare','gme_spare','x',NULL),
					 ('k3','tester','Old','gme_old','x',123)`,
				),
			]);
			const migration = await readFile(
				new URL(
					"../../drizzle/0044_supplier_api_allowlist.sql",
					import.meta.url,
				),
				"utf8",
			);
			await legacy.batch(
				migration
					.split("--> statement-breakpoint")
					.map((value) => value.trim())
					.filter(Boolean)
					.map((statement) => legacy.prepare(statement)),
			);
			const allowed = await legacy
				.prepare(
					"SELECT user_id FROM supplier_api_allowed_users ORDER BY user_id",
				)
				.all<{ user_id: string }>();
			expect(allowed.results).toEqual([{ user_id: "partner" }]);
		} finally {
			await fresh.dispose();
		}
	});
});
