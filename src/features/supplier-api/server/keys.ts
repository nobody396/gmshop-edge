import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { z } from "zod";
import { verifySensitiveAdminAction } from "#/features/auth/server/reauthenticate";
import { resolveStoreAccount } from "#/features/storefront/server/account";
import { DomainError } from "#/lib/domain-error";
import { m } from "#/paraglide/messages";
import { getDb } from "#/server/db.server";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { supplierApiKeyCreateSchema, supplierApiKeyIdSchema } from "../schema";
import { supplierApiIsEnabled } from "./auth";
import { createSupplierApiKey, revokeSupplierApiKey } from "./key-store";

export const listSupplierApiKeysFn = createServerFn({ method: "GET" }).handler(
	async () => {
		type ApiKeyRow = {
			id: string;
			name: string;
			key_id: string;
			last_used_at: number | null;
			revoked_at: number | null;
			created_at: number;
		};
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, { required: true });
		const userId = account?.user.id ?? "";
		const [enabled, keys] = await Promise.all([
			supplierApiIsEnabled(db),
			db
				.prepare(
					"SELECT id, name, key_id, last_used_at, revoked_at, created_at FROM supplier_api_keys WHERE user_id = ? ORDER BY created_at DESC, id DESC",
				)
				.bind(userId)
				.all<ApiKeyRow>(),
		]);
		return { enabled, keys: keys.results };
	},
);

export const createSupplierApiKeyFn = createServerFn({ method: "POST" })
	.validator((value: z.input<typeof supplierApiKeyCreateSchema>) =>
		supplierApiKeyCreateSchema.parse(value),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, { required: true });
		const userId = account?.user.id ?? "";
		if (!account?.user.emailVerified)
			throw new DomainError(
				"email_verification_required",
				403,
				m.auth_error_email_not_verified(),
			);
		await verifySensitiveAdminAction(request, userId, data);
		if (!(await supplierApiIsEnabled(db)))
			throw new DomainError(
				"supplier_api_not_enabled",
				403,
				"API purchasing is not enabled",
			);
		const runtime = await loadRuntimeConfig(db);
		if (!runtime.commerceSecret)
			throw new DomainError(
				"supplier_api_unavailable",
				503,
				"Supplier API unavailable",
			);
		return createSupplierApiKey(
			db,
			request,
			userId,
			runtime.commerceSecret,
			data,
		);
	});

export const revokeSupplierApiKeyFn = createServerFn({ method: "POST" })
	.validator((value: z.input<typeof supplierApiKeyIdSchema>) =>
		supplierApiKeyIdSchema.parse(value),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, { required: true });
		return revokeSupplierApiKey(db, request, account?.user.id ?? "", data.id);
	});
