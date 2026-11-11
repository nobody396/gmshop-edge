import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	alipayCredentialSchema,
	cryptomusCredentialSchema,
	epayCredentialSchema,
	gmpayCredentialSchema,
	type PaymentProvider,
	paymentProviderFamily,
	stripeCredentialSchema,
	wechatCredentialSchema,
} from "#/features/shop-payments/provider";
import { getPaymentProvider } from "#/features/shop-payments/providers";
import {
	manualSplitRefundSchema,
	paymentChannelEnabledSchema,
	paymentChannelIdSchema,
	paymentChannelInputSchema,
	paymentChannelListSchema,
	paymentChannelOrderSchema,
} from "#/features/shop-payments/schema";
import {
	assertPriceSource,
	priceLinkStatements,
} from "#/features/shop-payments/server/price-link";
import {
	channelHasUnsettledSplitPayments,
	completeSplitRefundsManually,
	listManualSplitRefunds,
} from "#/features/shop-payments/server/split";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { createAuditStatement } from "#/server/audit";
import {
	configurationLogoInputSchema,
	configurationLogoObjectKey,
	configurationLogoUrl,
	deleteConfigurationLogo,
	putConfigurationLogo,
} from "#/server/configuration-logo";
import { getAdminServerContext } from "#/server/context";
import { getCloudflareEnv } from "#/server/db.server";
import { loadRuntimeConfig } from "#/server/runtime-config";

type ChannelRow = {
	id: string;
	provider: PaymentProvider;
	name: string;
	currency: string;
	default_token: string;
	default_network: string;
	logo_object_key: string | null;
	logo_updated_at: number | null;
	credential_encrypted: string | null;
	fee_bps: number;
	fixed_fee_minor: string;
	sort_order: number;
	enabled: number;
	split_enabled: number;
	per_payment_max_minor: string;
	daily_max_minor: string;
	split_max_parts: number;
	price_source_channel_id: string | null;
	last_health_status: "unknown" | "healthy" | "unhealthy";
	last_checked_at: number | null;
	created_at: number;
	updated_at: number;
	attempt_count: number;
};

export const listPaymentChannelsFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof paymentChannelListSchema>) =>
		paymentChannelListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await getAdminServerContext(
			systemPermission("payments", "read"),
		);
		const search = data.search ? `%${data.search}%` : null;
		const where = search ? "WHERE pc.name LIKE ? OR pc.provider LIKE ?" : "";
		const bindings = search ? [search, search] : [];
		const [count, rows] = await db.$client.batch([
			db.$client
				.prepare(`SELECT COUNT(*) AS total FROM payment_channels pc ${where}`)
				.bind(...bindings),
			db.$client
				.prepare(
					`SELECT pc.*, (SELECT COUNT(*) FROM payment_attempts pa WHERE pa.channel_id = pc.id) AS attempt_count
					 FROM payment_channels pc ${where}
					 ORDER BY pc.sort_order, pc.created_at, pc.id LIMIT ? OFFSET ?`,
				)
				.bind(...bindings, data.pageSize, data.pageIndex * data.pageSize),
		]);
		const runtime = await loadRuntimeConfig(db.$client);
		return {
			data: await Promise.all(
				((rows?.results ?? []) as ChannelRow[]).map(async (row) => ({
					...presentChannel(row),
					paymentMethod: await channelPaymentMethod(
						row,
						runtime.commerceSecret,
					),
				})),
			),
			total: Number(
				(count?.results[0] as { total?: unknown } | undefined)?.total ?? 0,
			),
		};
	});

export const savePaymentChannelFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof paymentChannelInputSchema>) =>
		paymentChannelInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("payments", data.id ? "update" : "create"),
		);
		const before = data.id
			? await db.$client
					.prepare("SELECT * FROM payment_channels WHERE id = ? LIMIT 1")
					.bind(data.id)
					.first<ChannelRow>()
			: null;
		if (data.id && !before)
			throw new DomainError(
				"payment_channel_not_found",
				404,
				"Payment channel not found",
			);
		if (
			before &&
			paymentProviderFamily(before.provider) !==
				paymentProviderFamily(data.provider)
		)
			throw new DomainError(
				"payment_provider_immutable",
				409,
				"Payment provider cannot be changed",
			);
		const credential = await channelCredential(
			data,
			before?.credential_encrypted ?? null,
			db.$client,
		);
		const id = data.id ?? crypto.randomUUID();
		const now = Date.now();
		const limits = channelLimitValues(data);
		// Alipay channels may switch between 网站支付 and 订单码支付; other
		// providers keep their stored product.
		const provider =
			before && paymentProviderFamily(data.provider) !== "alipay"
				? before.provider
				: data.provider;
		// An open split plan keeps using its channel's product (QR, expiry,
		// refunds): the product may change only once every plan is settled.
		if (
			before &&
			before.provider !== provider &&
			(await channelHasUnsettledSplitPayments(db.$client, before.id))
		)
			throw new DomainError(
				"payment_provider_in_use",
				409,
				"Settle open split payments before changing the payment product",
			);
		const priceSourceId =
			provider === "alipay_qr" ? (data.priceSourceChannelId ?? null) : null;
		await assertPriceSource(db.$client, id, priceSourceId);
		const link = priceLinkStatements(db.$client, {
			channelId: id,
			sourceId: priceSourceId,
			now,
		});
		const mutation = data.id
			? db.$client
					.prepare(
						`UPDATE payment_channels SET provider = ?, name = ?, currency = ?, default_token = ?,
						 default_network = ?, credential_encrypted = ?,
					 credential_key_version = 1, fee_bps = ?, fixed_fee_minor = ?, sort_order = ?,
					 enabled = ?, split_enabled = ?, per_payment_max_minor = ?, daily_max_minor = ?,
					 split_max_parts = ?, price_source_channel_id = ?, last_health_status = 'unknown', last_checked_at = NULL, updated_at = ? WHERE id = ?`,
					)
					.bind(
						provider,
						data.name,
						data.currency,
						data.defaultToken,
						data.defaultNetwork,
						credential,
						data.feeBps,
						data.fixedFeeMinor,
						data.sortOrder,
						data.enabled,
						limits.splitEnabled,
						limits.perPaymentMaxMinor,
						limits.dailyMaxMinor,
						limits.splitMaxParts,
						priceSourceId,
						now,
						id,
					)
			: db.$client
					.prepare(
						`INSERT INTO payment_channels
					 (id, provider, name, currency, default_token, default_network,
					  credential_encrypted, credential_key_version,
					  fee_bps, fixed_fee_minor, sort_order, enabled, split_enabled,
					  per_payment_max_minor, daily_max_minor, split_max_parts,
					  price_source_channel_id, last_health_status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
					)
					.bind(
						id,
						data.provider,
						data.name,
						data.currency,
						data.defaultToken,
						data.defaultNetwork,
						credential,
						data.feeBps,
						data.fixedFeeMinor,
						data.sortOrder,
						data.enabled,
						limits.splitEnabled,
						limits.perPaymentMaxMinor,
						limits.dailyMaxMinor,
						limits.splitMaxParts,
						priceSourceId,
						now,
						now,
					);
		await db.$client.batch([
			...link.before,
			mutation,
			...link.after,
			createAuditStatement(db.$client, request, currentUser.id, {
				action: data.id ? "payment_channel.updated" : "payment_channel.created",
				targetType: "payment_channel",
				targetId: id,
				before: before ? presentChannel(before) : null,
				after: {
					provider,
					name: data.name,
					currency: data.currency,
					defaultToken: data.defaultToken,
					defaultNetwork: data.defaultNetwork,
					enabled: data.enabled,
					...limits,
					priceSourceChannelId: priceSourceId,
					hasCredential: true,
				},
			}),
		]);
		return { id };
	});

export const listManualSplitRefundsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await getAdminServerContext(
		systemPermission("payments", "read"),
	);
	return listManualSplitRefunds(db.$client);
});

/** 已人工退款: the owner refunded a split part in the Alipay console by hand. */
export const completeManualSplitRefundFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof manualSplitRefundSchema>) =>
		manualSplitRefundSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db } = await getAdminServerContext(
			systemPermission("orders", "update"),
		);
		return completeSplitRefundsManually(db.$client, {
			rowIds: [data.id],
			reference: data.reference,
			actorUserId: currentUser.id,
		});
	});

export const setPaymentChannelEnabledFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof paymentChannelEnabledSchema>) =>
		paymentChannelEnabledSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("payments", "update"),
		);
		const before = await db.$client
			.prepare("SELECT id, enabled FROM payment_channels WHERE id = ? LIMIT 1")
			.bind(data.id)
			.first<Record<string, unknown>>();
		if (!before)
			throw new DomainError(
				"payment_channel_not_found",
				404,
				"Payment channel not found",
			);
		await db.$client.batch([
			db.$client
				.prepare(
					"UPDATE payment_channels SET enabled = ?, updated_at = ? WHERE id = ?",
				)
				.bind(data.enabled, Date.now(), data.id),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "payment_channel.enabled_changed",
				targetType: "payment_channel",
				targetId: data.id,
				before,
				after: { enabled: data.enabled },
			}),
		]);
		return data;
	});

export const reorderPaymentChannelsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof paymentChannelOrderSchema>) =>
		paymentChannelOrderSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("payments", "update"),
		);
		const rows = await db.$client
			.prepare(
				"SELECT id FROM payment_channels ORDER BY sort_order, created_at, id",
			)
			.all<{ id: string }>();
		const requested = new Set(data.ids);
		const slots = rows.results
			.map((row, index) => (requested.has(row.id) ? index : -1))
			.filter((index) => index >= 0);
		if (slots.length !== data.ids.length)
			throw new DomainError(
				"payment_channel_order_invalid",
				409,
				"Payment channel order contains missing records",
			);
		const orderedIds = rows.results.map((row) => row.id);
		for (const [index, slot] of slots.entries()) {
			const id = data.ids[index];
			if (id) orderedIds[slot] = id;
		}
		const now = Date.now();
		await db.$client.batch([
			...orderedIds.map((id, index) =>
				db.$client
					.prepare(
						"UPDATE payment_channels SET sort_order = ?, updated_at = ? WHERE id = ?",
					)
					.bind((index + 1) * 100, now, id),
			),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "payment_channel.reordered",
				targetType: "payment_channel",
				targetId: "payment-channels",
				after: { ids: data.ids },
			}),
		]);
		return data;
	});

export const testPaymentChannelFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof paymentChannelIdSchema>) =>
		paymentChannelIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("payments", "update"),
		);
		const channel = await db.$client
			.prepare(
				"SELECT provider, credential_encrypted FROM payment_channels WHERE id = ? LIMIT 1",
			)
			.bind(data.id)
			.first<{ provider: string; credential_encrypted: string | null }>();
		if (!channel)
			throw new DomainError(
				"payment_channel_not_found",
				404,
				"Payment channel not found",
			);
		const runtime = await loadRuntimeConfig(db.$client);
		if (!runtime.commerceSecret || !channel.credential_encrypted)
			throw new DomainError(
				"payment_secret_unavailable",
				503,
				"Payment configuration unavailable",
			);
		const now = Date.now();
		let status: "healthy" | "unhealthy" = "healthy";
		try {
			const credential = JSON.parse(
				await decryptSecret(
					channel.credential_encrypted,
					runtime.commerceSecret,
					"payment-credential",
				),
			) as unknown;
			await getPaymentProvider(channel.provider).checkHealth(credential);
		} catch {
			status = "unhealthy";
		}
		await db.$client.batch([
			db.$client
				.prepare(
					"UPDATE payment_channels SET last_health_status = ?, last_checked_at = ?, updated_at = ? WHERE id = ?",
				)
				.bind(status, now, now, data.id),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "payment_channel.health_checked",
				targetType: "payment_channel",
				targetId: data.id,
				after: { status },
			}),
		]);
		return { id: data.id, status };
	});

export const uploadPaymentChannelLogoFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof configurationLogoInputSchema>) =>
		configurationLogoInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("payments", "update"),
		);
		const channel = await db.$client
			.prepare("SELECT id FROM payment_channels WHERE id = ? LIMIT 1")
			.bind(data.id)
			.first<{ id: string }>();
		if (!channel)
			throw new DomainError(
				"payment_channel_not_found",
				404,
				"Payment channel not found",
			);
		const key = configurationLogoObjectKey("payment", channel.id);
		const bucket = getCloudflareEnv(getRequest()).FILES;
		await putConfigurationLogo(bucket, key, data);
		const now = Date.now();
		await db.$client.batch([
			db.$client
				.prepare(
					"UPDATE payment_channels SET logo_object_key = ?, logo_updated_at = ?, updated_at = ? WHERE id = ?",
				)
				.bind(key, now, now, channel.id),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "payment_channel.logo_uploaded",
				targetType: "payment_channel",
				targetId: channel.id,
				after: { configured: true },
			}),
		]);
		return { url: configurationLogoUrl("payment", channel.id, now) };
	});

export const removePaymentChannelLogoFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof paymentChannelIdSchema>) =>
		paymentChannelIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("payments", "update"),
		);
		const channel = await db.$client
			.prepare(
				"SELECT logo_object_key FROM payment_channels WHERE id = ? LIMIT 1",
			)
			.bind(data.id)
			.first<{ logo_object_key: string | null }>();
		if (!channel)
			throw new DomainError(
				"payment_channel_not_found",
				404,
				"Payment channel not found",
			);
		const now = Date.now();
		await db.$client.batch([
			db.$client
				.prepare(
					"UPDATE payment_channels SET logo_object_key = NULL, logo_updated_at = NULL, updated_at = ? WHERE id = ?",
				)
				.bind(now, data.id),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "payment_channel.logo_removed",
				targetType: "payment_channel",
				targetId: data.id,
				after: { configured: false },
			}),
		]);
		if (channel.logo_object_key)
			await deleteConfigurationLogo(
				getCloudflareEnv(getRequest()).FILES,
				channel.logo_object_key,
			);
		return { id: data.id };
	});

export const deletePaymentChannelFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof paymentChannelIdSchema>) =>
		paymentChannelIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("payments", "delete"),
		);
		const before = await db.$client
			.prepare(
				"SELECT pc.*, (SELECT COUNT(*) FROM payment_attempts pa WHERE pa.channel_id = pc.id) AS attempt_count FROM payment_channels pc WHERE pc.id = ? LIMIT 1",
			)
			.bind(data.id)
			.first<ChannelRow>();
		if (!before)
			throw new DomainError(
				"payment_channel_not_found",
				404,
				"Payment channel not found",
			);
		if (before.attempt_count > 0)
			throw new DomainError(
				"payment_channel_in_use",
				409,
				"Used payment configurations cannot be deleted",
			);
		await db.$client.batch([
			db.$client
				.prepare("DELETE FROM payment_channels WHERE id = ?")
				.bind(data.id),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "payment_channel.deleted",
				targetType: "payment_channel",
				targetId: data.id,
				before: presentChannel(before),
			}),
		]);
		if (before.logo_object_key)
			await getCloudflareEnv(getRequest())
				.FILES?.delete(before.logo_object_key)
				.catch(() => undefined);
		return { id: data.id };
	});

async function channelCredential(
	data: z.output<typeof paymentChannelInputSchema>,
	current: string | null,
	db: D1Database,
) {
	let value = credentialValue(data);
	if (
		!value &&
		current &&
		(data.provider === "gmpay" || data.provider === "epay")
	) {
		const runtime = await loadRuntimeConfig(db);
		if (!runtime.commerceSecret)
			throw new DomainError(
				"payment_secret_unavailable",
				503,
				"Payment configuration unavailable",
			);
		const schema =
			data.provider === "gmpay" ? gmpayCredentialSchema : epayCredentialSchema;
		const currentValue = schema.parse(
			JSON.parse(
				await decryptSecret(
					current,
					runtime.commerceSecret,
					"payment-credential",
				),
			),
		);
		value =
			data.provider === "epay"
				? epayCredentialSchema.parse({
						...currentValue,
						paymentMethod: data.epusdtPaymentMethod,
					})
				: currentValue;
	}
	if (!value) {
		if (current) return current;
		throw new DomainError(
			"payment_credential_required",
			400,
			"Payment credential is required",
		);
	}
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"payment_secret_unavailable",
			503,
			"Payment configuration unavailable",
		);
	return encryptSecret(
		JSON.stringify(value),
		runtime.commerceSecret,
		"payment-credential",
	);
}

function credentialValue(data: z.output<typeof paymentChannelInputSchema>) {
	if (data.provider === "cryptomus") {
		if (!data.cryptomusMerchantId && !data.cryptomusPaymentApiKey) return null;
		return cryptomusCredentialSchema.parse({
			merchantId: data.cryptomusMerchantId,
			paymentApiKey: data.cryptomusPaymentApiKey,
		});
	}
	if (data.provider === "stripe") {
		if (!data.stripeSecretKey && !data.stripeWebhookSecret) return null;
		return stripeCredentialSchema.parse({
			secretKey: data.stripeSecretKey,
			webhookSecret: data.stripeWebhookSecret,
		});
	}
	if (paymentProviderFamily(data.provider) === "alipay") {
		if (
			!data.alipayAppId &&
			!data.alipaySellerId &&
			!data.alipayPrivateKeyPem &&
			!data.alipayPublicKeyPem
		)
			return null;
		return alipayCredentialSchema.parse({
			appId: data.alipayAppId,
			sellerId: data.alipaySellerId,
			privateKeyPem: data.alipayPrivateKeyPem,
			alipayPublicKeyPem: data.alipayPublicKeyPem,
		});
	}
	if (data.provider === "wechat_native" || data.provider === "wechat_h5") {
		if (
			!data.wechatAppId &&
			!data.wechatMchId &&
			!data.wechatMerchantSerialNumber &&
			!data.wechatMerchantPrivateKeyPem &&
			!data.wechatApiV3Key &&
			!data.wechatPlatformSerialNumber &&
			!data.wechatPlatformPublicKeyPem
		)
			return null;
		return wechatCredentialSchema.parse({
			appId: data.wechatAppId,
			mchId: data.wechatMchId,
			merchantSerialNumber: data.wechatMerchantSerialNumber,
			merchantPrivateKeyPem: data.wechatMerchantPrivateKeyPem,
			apiV3Key: data.wechatApiV3Key,
			platformSerialNumber: data.wechatPlatformSerialNumber,
			platformPublicKeyPem: data.wechatPlatformPublicKeyPem,
		});
	}
	if (!data.epusdtBaseUrl && !data.epusdtPid && !data.epusdtSecretKey)
		return null;
	const credential = {
		baseUrl: data.epusdtBaseUrl,
		pid: data.epusdtPid,
		secretKey: data.epusdtSecretKey,
	};
	if (data.provider === "gmpay") return gmpayCredentialSchema.parse(credential);
	return epayCredentialSchema.parse({
		...credential,
		paymentMethod: data.epusdtPaymentMethod,
	});
}

/** Limits apply to Alipay QR channels only; other providers keep the defaults. */
function channelLimitValues(data: z.output<typeof paymentChannelInputSchema>) {
	if (data.provider !== "alipay_qr")
		return {
			splitEnabled: false,
			perPaymentMaxMinor: "0",
			dailyMaxMinor: "0",
			splitMaxParts: 10,
		};
	return {
		splitEnabled: data.splitEnabled,
		perPaymentMaxMinor: data.perPaymentMaxMinor,
		dailyMaxMinor: data.dailyMaxMinor,
		splitMaxParts: data.splitMaxParts,
	};
}

async function channelPaymentMethod(
	row: ChannelRow,
	commerceSecret: string | null,
) {
	if (row.provider !== "epay") return "";
	if (!commerceSecret || !row.credential_encrypted) return "alipay";
	try {
		return epayCredentialSchema.parse(
			JSON.parse(
				await decryptSecret(
					row.credential_encrypted,
					commerceSecret,
					"payment-credential",
				),
			),
		).paymentMethod;
	} catch {
		return "alipay";
	}
}

function presentChannel(row: ChannelRow) {
	return {
		id: row.id,
		provider: row.provider,
		name: row.name,
		currency: row.currency,
		defaultToken: row.default_token,
		defaultNetwork: row.default_network,
		logoUrl:
			row.logo_object_key && row.logo_updated_at
				? configurationLogoUrl("payment", row.id, row.logo_updated_at)
				: null,
		feeBps: row.fee_bps,
		fixedFeeMinor: row.fixed_fee_minor,
		sortOrder: row.sort_order,
		enabled: Boolean(row.enabled),
		splitEnabled: Boolean(row.split_enabled),
		perPaymentMaxMinor: row.per_payment_max_minor ?? "0",
		dailyMaxMinor: row.daily_max_minor ?? "0",
		splitMaxParts: Number(row.split_max_parts ?? 10),
		priceSourceChannelId: row.price_source_channel_id ?? null,
		healthStatus: row.last_health_status,
		lastCheckedAt: row.last_checked_at,
		hasCredential: Boolean(row.credential_encrypted),
		attemptCount: Number(row.attempt_count ?? 0),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
