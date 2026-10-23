import type { z } from "zod";
import type { supplierApiKeyCreateSchema } from "#/features/supplier-api/schema";
import { DomainError } from "#/lib/domain-error";
import { encryptSecret } from "#/lib/secrets";

const maximumActiveKeys = 10;

export async function createSupplierApiKey(
	db: D1Database,
	request: Request,
	userId: string,
	commerceSecret: string,
	input: z.infer<typeof supplierApiKeyCreateSchema>,
) {
	if (!(await supplierApiUserAllowed(db, userId)))
		throw supplierApiNotAllowed();
	const id = crypto.randomUUID();
	const apiKey = `gme_${crypto.randomUUID().replaceAll("-", "")}`;
	const apiSecret = Array.from(
		crypto.getRandomValues(new Uint8Array(32)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
	const now = Date.now();
	let results: D1Result<unknown>[];
	try {
		results = await db.batch([
			db
				.prepare(
					`INSERT INTO supplier_api_keys
					 (id, user_id, name, key_id, secret_encrypted, secret_revision,
					  allowed_callback_origin, created_at, updated_at)
					 SELECT ?, ?, ?, ?, ?, 1, NULL, ?, ?
					 WHERE (SELECT COUNT(*) FROM supplier_api_keys
					        WHERE user_id = ? AND revoked_at IS NULL) < ?
					 AND EXISTS (SELECT 1 FROM supplier_api_allowed_users WHERE user_id = ?)`,
				)
				.bind(
					id,
					userId,
					input.name,
					apiKey,
					await encryptSecret(apiSecret, commerceSecret, "supplier-api-key"),
					now,
					now,
					userId,
					maximumActiveKeys,
					userId,
				),
			apiKeyAuditStatement(db, request, userId, {
				id,
				action: "supplier_api.key_created",
				after: { name: input.name, keyId: apiKey },
				requiredRevokedAt: null,
				now,
			}),
		]);
	} catch (error) {
		if (
			String(error).includes(
				"supplier_api_keys.user_id, supplier_api_keys.name",
			)
		)
			throw new DomainError(
				"supplier_api_key_name_in_use",
				409,
				"An API key already uses this name",
			);
		throw error;
	}
	if (Number(results[0]?.meta.changes ?? 0) !== 1) {
		if (!(await supplierApiUserAllowed(db, userId)))
			throw supplierApiNotAllowed();
		throw new DomainError(
			"supplier_api_key_limit_reached",
			409,
			"Revoke an existing API key before creating another",
		);
	}
	return { apiKey, apiSecret };
}

/**
 * Supplier-API purchasing (agent supply prices) is limited to accounts an
 * administrator explicitly allowed; a verified email alone is not enough.
 */
export async function supplierApiUserAllowed(db: D1Database, userId: string) {
	if (!userId) return false;
	const row = await db
		.prepare(
			"SELECT 1 AS allowed FROM supplier_api_allowed_users WHERE user_id = ? LIMIT 1",
		)
		.bind(userId)
		.first<{ allowed: number }>();
	return Boolean(row);
}

export async function allowSupplierApiUser(
	db: D1Database,
	userId: string,
	input: { grantedBy: string | null; note?: string | null },
) {
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO supplier_api_allowed_users (user_id, granted_by, note, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET granted_by = excluded.granted_by,
			 note = excluded.note, updated_at = excluded.updated_at`,
		)
		.bind(userId, input.grantedBy, input.note ?? null, now, now)
		.run();
}

export async function disallowSupplierApiUser(db: D1Database, userId: string) {
	const result = await db
		.prepare("DELETE FROM supplier_api_allowed_users WHERE user_id = ?")
		.bind(userId)
		.run();
	return Number(result.meta.changes ?? 0) > 0;
}

function supplierApiNotAllowed() {
	return new DomainError(
		"supplier_api_not_allowed",
		403,
		"API purchasing is not enabled for this account",
	);
}

export async function revokeSupplierApiKey(
	db: D1Database,
	request: Request,
	userId: string,
	keyId: string,
) {
	const now = Date.now();
	const results = await db.batch([
		db
			.prepare(
				`UPDATE supplier_api_keys SET revoked_at = ?, updated_at = ?
				 WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
			)
			.bind(now, now, keyId, userId),
		apiKeyAuditStatement(db, request, userId, {
			id: keyId,
			action: "supplier_api.key_revoked",
			after: { revoked: true },
			requiredRevokedAt: now,
			now,
		}),
	]);
	return {
		revoked: true as const,
		duplicate: Number(results[0]?.meta.changes ?? 0) !== 1,
	};
}

function apiKeyAuditStatement(
	db: D1Database,
	request: Request,
	userId: string,
	input: {
		id: string;
		action: string;
		after: Record<string, unknown>;
		requiredRevokedAt: number | null;
		now: number;
	},
) {
	return db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id,
			  ip_address, after, created_at)
			 SELECT ?, ?, ?, 'supplier_api_key', id, ?, ?, ?, ?
			 FROM supplier_api_keys WHERE id = ? AND user_id = ?
			 AND ((? IS NULL AND revoked_at IS NULL) OR revoked_at = ?)`,
		)
		.bind(
			crypto.randomUUID(),
			userId,
			input.action,
			request.headers.get("x-request-id"),
			request.headers.get("cf-connecting-ip"),
			JSON.stringify(input.after),
			input.now,
			input.id,
			userId,
			input.requiredRevokedAt,
			input.requiredRevokedAt,
		);
}
