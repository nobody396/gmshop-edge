import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import {
	allowSupplierApiUser,
	createSupplierApiKey,
	revokeSupplierApiKey,
} from "#/features/supplier-api/server/key-store";
import { createUser, resetUserPassword } from "#/features/users/server/users";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("supplier API key lifecycle", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const request = new Request("https://shop.example/account", {
		headers: { "x-request-id": "supplier-key-test" },
	});
	const commerceSecret = createInitialRuntimeConfig(
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
	});

	afterEach(async () => miniflare.dispose());

	it("stores named keys, enforces the active limit, and audits lifecycle changes", async () => {
		const user = await createUser(drizzle(db, { schema }), {
			name: "API customer",
			email: "api-customer@example.com",
			enabled: true,
			password: "current-password",
		});
		await allowSupplierApiUser(db, user.id, { grantedBy: null });
		let firstKeyId = "";
		for (let index = 0; index < 10; index += 1) {
			const key = await createSupplierApiKey(
				db,
				request,
				user.id,
				commerceSecret,
				{ name: `Store ${index}`, password: "current-password" },
			);
			if (index === 0) firstKeyId = key.apiKey;
			expect(key.apiSecret).toHaveLength(64);
		}
		await expect(
			createSupplierApiKey(db, request, user.id, commerceSecret, {
				name: "Overflow",
				password: "current-password",
			}),
		).rejects.toMatchObject({
			code: "supplier_api_key_limit_reached",
			status: 409,
		});
		const first = await db
			.prepare("SELECT id, name FROM supplier_api_keys WHERE key_id = ?")
			.bind(firstKeyId)
			.first<{ id: string; name: string }>();
		expect(first?.name).toBe("Store 0");
		await expect(
			revokeSupplierApiKey(db, request, user.id, first?.id ?? ""),
		).resolves.toMatchObject({ revoked: true, duplicate: false });
		await expect(
			createSupplierApiKey(db, request, user.id, commerceSecret, {
				name: "Replacement",
				password: "current-password",
			}),
		).resolves.toMatchObject({ apiKey: expect.stringMatching(/^gme_/) });
		const state = await db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM supplier_api_keys WHERE user_id = ? AND revoked_at IS NULL) AS active,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'supplier_api.key_created') AS created_audits,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'supplier_api.key_revoked') AS revoked_audits`,
			)
			.bind(user.id)
			.first<Record<string, number>>();
		expect(state).toEqual({
			active: 10,
			created_audits: 11,
			revoked_audits: 1,
		});
	});

	it("revokes every active key when an administrator resets the password", async () => {
		const appDb = drizzle(db, { schema });
		const user = await createUser(appDb, {
			name: "Recovered customer",
			email: "recovered@example.com",
			enabled: true,
			password: "current-password",
		});
		await allowSupplierApiUser(db, user.id, { grantedBy: null });
		await createSupplierApiKey(db, request, user.id, commerceSecret, {
			name: "Compromised integration",
			password: "current-password",
		});
		await resetUserPassword(appDb, {
			id: user.id,
			password: "replacement-password",
		});
		const active = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM supplier_api_keys WHERE user_id = ? AND revoked_at IS NULL",
			)
			.bind(user.id)
			.first<{ count: number }>();
		expect(active?.count).toBe(0);
	});
});
