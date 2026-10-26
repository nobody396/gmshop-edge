import { claimInterval } from "#/features/ops-automation/server/shared";
import { deliverOwnerAlert } from "#/features/telegram/server/owner-alerts";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { isIanaTimezone, parseScamalyticsScore } from "../domain";

/** Owner alert sink; tests inject it, production uses the Telegram owner channel. */
export type Deliver = (text: string) => Promise<void>;

export const secretPurpose = {
	relaySecret: "claude-env:relay-secret",
	relayPass: "claude-env:relay-pass",
	upstreamUser: "claude-env:upstream-user",
	upstreamPass: "claude-env:upstream-pass",
} as const;

export type Crypt = {
	encrypt(value: string, purpose: string): Promise<string>;
	decrypt(value: string, purpose: string): Promise<string>;
};

/** Encryption with the deployment's data key (same helper as every other secret). */
export async function loadCrypt(db: D1Database): Promise<Crypt> {
	const secret = (await loadRuntimeConfig(db)).integrationConfigSecret;
	if (!secret) throw new Error("claude_env_secret_unavailable");
	return {
		encrypt: (value, purpose) => encryptSecret(value, secret, purpose),
		decrypt: (value, purpose) => decryptSecret(value, secret, purpose),
	};
}

export function defaultDeliver(db: D1Database, fetcher: typeof fetch): Deliver {
	return async (text) => {
		await deliverOwnerAlert(db, text, {
			fetcher,
			uuid: `claude-env-${crypto.randomUUID()}`,
		});
	};
}

/** Sends at most once per `intervalMs` for `key`; a failed send is swallowed. */
export async function alertThrottled(
	db: D1Database,
	deliver: Deliver,
	key: string,
	text: string,
	now: number,
	intervalMs: number,
) {
	if (!(await claimInterval(db, key, now, intervalMs))) return false;
	await deliver(text).catch(() => undefined);
	return true;
}

export function eventStatement(
	db: D1Database,
	subscriptionId: string | null,
	kind: string,
	detail: string | null,
	now: number,
) {
	return db
		.prepare(
			"INSERT INTO claude_env_events (id, subscription_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), subscriptionId, kind, detail, now);
}

const lookupTimeoutMs = 10_000;
const browserAgent =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** ip.net.coffee Claude trust_score; null when unreachable/unreadable (warn only). */
export async function lookupTrustScore(ip: string, fetcher: typeof fetch) {
	try {
		const response = await fetcher(
			`https://ip.net.coffee/api/iprisk/${encodeURIComponent(ip)}`,
			{
				headers: { Accept: "application/json", "User-Agent": browserAgent },
				signal: AbortSignal.timeout(lookupTimeoutMs),
			},
		);
		if (!response.ok) return null;
		const value = (await response.json()) as { trust_score?: unknown };
		const score = Number(value?.trust_score);
		return value?.trust_score !== null &&
			value?.trust_score !== undefined &&
			Number.isFinite(score)
			? score
			: null;
	} catch {
		return null;
	}
}

/** scamalytics "Fraud Score: N"; null when unreachable/unreadable (warn only). */
export async function lookupScamScore(ip: string, fetcher: typeof fetch) {
	try {
		const response = await fetcher(
			`https://scamalytics.com/ip/${encodeURIComponent(ip)}`,
			{
				headers: { "User-Agent": browserAgent },
				signal: AbortSignal.timeout(lookupTimeoutMs),
			},
		);
		if (!response.ok) return null;
		return parseScamalyticsScore(await response.text());
	} catch {
		return null;
	}
}

/** ip-api timezone (IANA) or null. */
export async function lookupTimezone(ip: string, fetcher: typeof fetch) {
	try {
		const response = await fetcher(
			`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,timezone`,
			{ signal: AbortSignal.timeout(lookupTimeoutMs) },
		);
		if (!response.ok) return null;
		const value = (await response.json()) as {
			status?: unknown;
			timezone?: unknown;
		};
		return value?.status === "success" && isIanaTimezone(value.timezone)
			? value.timezone
			: null;
	} catch {
		return null;
	}
}
