import { z } from "zod";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";

const tenantTokenUrl =
	"https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const messagesUrl =
	"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";
export const feishuAppSecretPurpose =
	"telegram-support:feishu-app-secret" as const;

export const feishuAlertSettingKeys = {
	enabled: "telegram.support.feishu_alerts_enabled",
	appId: "telegram.support.feishu_app_id",
	appSecret: "telegram.support.feishu_app_secret",
	chatId: "telegram.support.feishu_chat_id",
	lastSentAt: "telegram.support.feishu_last_sent_at",
	lastErrorCode: "telegram.support.feishu_last_error_code",
} as const;

export const feishuAlertSettingsInputSchema = z.object({
	enabled: z.boolean(),
	appId: z
		.string()
		.trim()
		.regex(/^cli_[A-Za-z0-9]{8,64}$/)
		.nullable(),
	appSecret: z.string().trim().min(1).max(1_000).optional(),
	chatId: z
		.string()
		.trim()
		.regex(/^oc_[A-Za-z0-9]{8,128}$/)
		.nullable(),
});

const tokenResponseSchema = z.object({
	code: z.number().int(),
	msg: z.string().optional(),
	tenant_access_token: z.string().min(1).optional(),
	expire: z.number().int().positive().optional(),
});

const apiResponseSchema = z.object({
	code: z.number().int(),
	msg: z.string().optional(),
	data: z.unknown().optional(),
});

type Fetcher = typeof fetch;
type FeishuCredentials = { appId: string; appSecret: string; chatId: string };
type TokenCacheEntry = { token: string; expiresAt: number };

const tokenCache = new Map<string, TokenCacheEntry>();

export class FeishuAlertError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

export async function loadFeishuAlertSettings(db: D1Database) {
	const values = await loadSettingValues(db);
	return {
		enabled: bool(values.get(feishuAlertSettingKeys.enabled), false),
		appId: nullableString(values.get(feishuAlertSettingKeys.appId)),
		chatId: nullableString(values.get(feishuAlertSettingKeys.chatId)),
		hasAppSecret:
			typeof values.get(feishuAlertSettingKeys.appSecret) === "string",
		lastSentAt: nullableInteger(values.get(feishuAlertSettingKeys.lastSentAt)),
		lastErrorCode: nullableString(
			values.get(feishuAlertSettingKeys.lastErrorCode),
		),
	};
}

export async function resolveFeishuAlertCredentials(
	db: D1Database,
	options: { requireEnabled?: boolean } = {},
) {
	const values = await loadSettingValues(db);
	if (
		options.requireEnabled !== false &&
		!bool(values.get(feishuAlertSettingKeys.enabled), false)
	)
		return null;
	const appId = nullableString(values.get(feishuAlertSettingKeys.appId));
	const chatId = nullableString(values.get(feishuAlertSettingKeys.chatId));
	const encrypted = nullableString(
		values.get(feishuAlertSettingKeys.appSecret),
	);
	if (!appId || !chatId || !encrypted) return null;
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.integrationConfigSecret)
		throw new FeishuAlertError("feishu_secret_unavailable");
	try {
		return {
			appId,
			chatId,
			appSecret: await decryptSecret(
				encrypted,
				runtime.integrationConfigSecret,
				feishuAppSecretPurpose,
			),
		};
	} catch {
		throw new FeishuAlertError("feishu_secret_invalid");
	}
}

export async function encryptFeishuAppSecret(
	db: D1Database,
	appSecret: string,
) {
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.integrationConfigSecret)
		throw new FeishuAlertError("feishu_secret_unavailable");
	return encryptSecret(
		appSecret,
		runtime.integrationConfigSecret,
		feishuAppSecretPurpose,
	);
}

export async function verifyFeishuAppBot(
	credentials: FeishuCredentials,
	request: Fetcher = fetch,
) {
	const token = await tenantAccessToken(credentials, request, false);
	const response = await request(
		`https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(credentials.chatId)}`,
		{
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(8_000),
		},
	).catch(() => null);
	if (!response?.ok) throw new FeishuAlertError("feishu_chat_unavailable");
	const payload = apiResponseSchema.safeParse(
		await response.json().catch(() => null),
	);
	if (!payload.success || payload.data.code !== 0)
		throw new FeishuAlertError("feishu_chat_unavailable");
	return { verified: true as const };
}

export async function sendFeishuText(
	credentials: FeishuCredentials,
	text: string,
	request: Fetcher = fetch,
) {
	const token = await tenantAccessToken(credentials, request, true);
	const response = await request(messagesUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify({
			receive_id: credentials.chatId,
			msg_type: "text",
			content: JSON.stringify({ text: text.slice(0, 30_000) }),
		}),
		signal: AbortSignal.timeout(8_000),
	}).catch(() => null);
	if (!response?.ok) throw new FeishuAlertError("feishu_delivery_failed");
	const payload = apiResponseSchema.safeParse(
		await response.json().catch(() => null),
	);
	if (!payload.success || payload.data.code !== 0)
		throw new FeishuAlertError("feishu_delivery_failed");
	return { sent: true as const };
}

export function formatFeishuWebSupportAlert(
	topicName: string | null | undefined,
	message: string,
	now = Date.now(),
) {
	const customer = topicName?.trim() || "网页访客";
	const time = new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})
		.format(now)
		.replaceAll("/", "-");
	return [
		"🔔 网页客服新消息",
		`客户：${customer.slice(0, 128)}`,
		`内容：${message.trim().slice(0, 3_500)}`,
		`时间：${time}（北京时间）`,
		"请到 Telegram 客服群对应话题回复。",
	].join("\n");
}

export async function recordFeishuAlertResult(
	db: D1Database,
	result: { sent: true } | { sent: false; errorCode: string },
) {
	const now = Date.now();
	const statements = result.sent
		? [
				upsertSetting(db, feishuAlertSettingKeys.lastSentAt, now, now),
				db
					.prepare("DELETE FROM system_settings WHERE key = ?")
					.bind(feishuAlertSettingKeys.lastErrorCode),
			]
		: [
				upsertSetting(
					db,
					feishuAlertSettingKeys.lastErrorCode,
					result.errorCode.slice(0, 100),
					now,
				),
			];
	await db.batch(statements);
}

export function feishuAlertErrorCode(error: unknown) {
	return error instanceof FeishuAlertError
		? error.code
		: "feishu_delivery_failed";
}

export function upsertFeishuAlertSetting(
	db: D1Database,
	key: string,
	value: unknown,
	now: number,
	isSecret = false,
) {
	return db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 is_secret = excluded.is_secret, updated_at = excluded.updated_at`,
		)
		.bind(key, JSON.stringify(value), isSecret ? 1 : 0, now, now);
}

async function tenantAccessToken(
	credentials: FeishuCredentials,
	request: Fetcher,
	useCache: boolean,
) {
	const cacheKey = await credentialFingerprint(credentials);
	const cached = tokenCache.get(cacheKey);
	if (useCache && cached && cached.expiresAt > Date.now()) return cached.token;
	const response = await request(tenantTokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({
			app_id: credentials.appId,
			app_secret: credentials.appSecret,
		}),
		signal: AbortSignal.timeout(8_000),
	}).catch(() => null);
	if (!response?.ok) throw new FeishuAlertError("feishu_token_unavailable");
	const payload = tokenResponseSchema.safeParse(
		await response.json().catch(() => null),
	);
	if (
		!payload.success ||
		payload.data.code !== 0 ||
		!payload.data.tenant_access_token
	)
		throw new FeishuAlertError("feishu_credentials_invalid");
	tokenCache.set(cacheKey, {
		token: payload.data.tenant_access_token,
		expiresAt:
			Date.now() + Math.max(60, (payload.data.expire ?? 7_200) - 300) * 1_000,
	});
	return payload.data.tenant_access_token;
}

async function credentialFingerprint(credentials: FeishuCredentials) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${credentials.appId}\0${credentials.appSecret}`),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function loadSettingValues(db: D1Database) {
	const keys = Object.values(feishuAlertSettingKeys);
	const rows = await db
		.prepare(
			`SELECT key, value FROM system_settings WHERE key IN (${keys.map(() => "?").join(", ")})`,
		)
		.bind(...keys)
		.all<{ key: string; value: string }>();
	return new Map(rows.results.map((row) => [row.key, parse(row.value)]));
}

function upsertSetting(
	db: D1Database,
	key: string,
	value: unknown,
	now: number,
) {
	return upsertFeishuAlertSetting(db, key, value, now);
}

function parse(value: string) {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

function bool(value: unknown, fallback: boolean) {
	return typeof value === "boolean" ? value : fallback;
}

function nullableString(value: unknown) {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableInteger(value: unknown) {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}
