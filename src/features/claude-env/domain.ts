/**
 * Claude 稳定使用环境 (hosted dedicated US IP): pure rules shared by the
 * control-center cron, the relay API, the customer panel and the admin view.
 * Contract: claude-env-setup/docs/CONTROL_API.md (v1).
 */

export const claudeEnvProductId = "f2b92a96-290c-4ffa-aaf5-a26e7a35815d";

export type ClaudeEnvPlan =
	| "monthly"
	| "quarterly"
	| "eb_monthly"
	| "eb_quarterly";

/** IPRoyal reseller product 9 (ISP), plan 22 = 30 days, plan 25 = 90 days. */
export const claudeEnvSkus: Record<
	string,
	{ plan: ClaudeEnvPlan; days: number; iproyalPlanId: number }
> = {
	"979f1ac1-5082-4758-bc3c-90b3230ee03f": {
		plan: "eb_monthly",
		days: 30,
		iproyalPlanId: 22,
	},
	"c4eb3fd5-88c9-4505-aa8a-8d4908e8b819": {
		plan: "eb_quarterly",
		days: 90,
		iproyalPlanId: 25,
	},
	"c3bab030-0c3c-4451-9c41-3cc32538e778": {
		plan: "monthly",
		days: 30,
		iproyalPlanId: 22,
	},
	"1e599d3a-3aa2-498e-a955-f4b04a4abdc4": {
		plan: "quarterly",
		days: 90,
		iproyalPlanId: 25,
	},
};

export const claudeEnvSkuIds = Object.keys(claudeEnvSkus);

export const claudeEnvSettingKeys = {
	/** Feature flag; anything but `true` keeps the whole flow idle. */
	enabled: "claude_env.automation_enabled",
	/** Orders paid before this millisecond timestamp are never ingested. */
	ingestAfter: "claude_env.ingest_after",
	alertNoRelay: "claude_env.alert.no_relay_at",
	alertNoToken: "claude_env.alert.no_token_at",
	alertBalance: "claude_env.alert.balance_short_at",
	alertBalanceLow: "claude_env.alert.balance_low_at",
	/** Last IPRoyal order reconciliation (at most every 10 minutes). */
	reconcileAt: "claude_env.iproyal_reconcile_at",
	/** Latest reconciliation result shown on /admin/claude-env (no credentials). */
	reconcileSnapshot: "claude_env.iproyal_orders_snapshot",
	/** `<prefix><order id>`: one owner alert per unknown IPRoyal order. */
	alertUnknownOrderPrefix: "claude_env.alert.unknown_order.",
} as const;

export const dayMs = 86_400_000;
export const trafficPeriodMs = 30 * dayMs;
export const relayOfflineMs = 5 * 60_000;
export const relaySkewSeconds = 300;
export const relayPortMin = 20_000;
export const relayPortMax = 20_999;
export const defaultMaxCustomers = 10;
export const defaultMonthlyQuotaBytes = 5_000_000_000_000;
export const trafficQuotaBytes = 200_000_000_000;
export const minTrustScore = 80;
export const maxScamScore = 40;
export const lowBalanceUsd = 10;
export const patrolFailThreshold = 3;
/** Consecutive failed provisioning self-tests before an IP is declared bad. */
export const provisioningFailThreshold = 3;

/** No grace period: an expired subscription drops out of the relay list at once. */
export const desiredStatuses = ["provisioning", "active"] as const;
/** Statuses that occupy a relay slot (capacity counting). */
export const relaySlotStatuses = [
	"awaiting_ip",
	"provisioning",
	"active",
	"needs_replace",
	"suspended",
] as const;

export type ClaudeEnvStatus =
	| "awaiting_ip"
	| "provisioning"
	| "active"
	| "needs_replace"
	| "expired"
	| "suspended"
	| "cancelled";

// ---------- encoding helpers ----------

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array) {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlNoPad(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

// ---------- activation code ----------

export type ActivationPayload = {
	host: string;
	port: number;
	user: string;
	pass: string;
	ip: string;
	tz: string;
};

/**
 * "CE1-" + base64url(no padding) of compact JSON with keys in this exact order
 * {"v":1,"host","port","user","pass","ip","tz"} — byte-identical to
 * `json.dumps(payload, separators=(",", ":"), ensure_ascii=False)` in
 * relay/ce-relay `code` for the ASCII values we generate.
 */
export function encodeActivationCode(input: ActivationPayload) {
	const json = JSON.stringify({
		v: 1,
		host: input.host,
		port: input.port,
		user: input.user,
		pass: input.pass,
		ip: input.ip,
		tz: input.tz,
	});
	return `CE1-${base64UrlNoPad(encoder.encode(json))}`;
}

export function decodeActivationCode(code: string) {
	if (!code.startsWith("CE1-")) return null;
	const b64 = code.slice(4).replaceAll("-", "+").replaceAll("_", "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	try {
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes)) as {
			v: number;
		} & ActivationPayload;
	} catch {
		return null;
	}
}

// ---------- relay request signing ----------

export async function sha256Hex(value: string | Uint8Array) {
	const bytes =
		typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * X-CE-Signature = lowercase hex HMAC-SHA256 over
 *   method + "\n" + path(with query) + "\n" + timestamp + "\n" + sha256hex(body)
 * The HMAC key is the relay secret string's UTF-8 bytes exactly as stored in
 * /etc/ce-relay/control.json (the 64-char hex text itself, NOT hex-decoded).
 * Python equivalent: hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest().
 */
export async function signRelayRequest(input: {
	secret: string;
	method: string;
	path: string;
	timestamp: string;
	body: string | Uint8Array;
}) {
	const message = `${input.method.toUpperCase()}\n${input.path}\n${input.timestamp}\n${await sha256Hex(input.body)}`;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(input.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return toHex(
		new Uint8Array(
			await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
		),
	);
}

export function timingSafeEqualHex(left: string, right: string) {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

// ---------- credentials ----------

const urlSafe =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Relay inbound user: "u" + 12 lowercase hex. */
export function generateRelayUser() {
	return `u${toHex(crypto.getRandomValues(new Uint8Array(6)))}`;
}

/** Relay inbound password: 24 chars of [A-Za-z0-9_-] (64 symbols, no modulo bias). */
export function generateRelayPass() {
	return Array.from(
		crypto.getRandomValues(new Uint8Array(24)),
		(byte) => urlSafe[byte & 63],
	).join("");
}

export function generateSubscriptionId() {
	return `sub_${toHex(crypto.getRandomValues(new Uint8Array(10)))}`;
}

/** Lowest free port in 20000–20999 that is not in `used`; null when full. */
export function pickRelayPort(used: Iterable<number>) {
	const taken = new Set(used);
	for (let port = relayPortMin; port <= relayPortMax; port += 1)
		if (!taken.has(port)) return port;
	return null;
}

// ---------- IPRoyal city choice ----------

export type IproyalCity = { id: number; name: string; out_of_stock?: boolean };

const cityPreference = [
	/^Springfield \(Massachusetts\)$/,
	/New York|District Of Columbia|Boston|Massachusetts|New Jersey|Philadelphia|Pennsylvania|Virginia|Maryland|Delaware/,
	/Seattle|Washington\)|San Francisco|San Jose|Los Angeles|El Segundo|California|Portland|Oregon/,
];

export const iproyalIspProductId = 9;
export const iproyalUsLocationId = 16;

/** In-stock children of US location 16: Springfield MA → east → west → anything. */
export function pickIproyalCity(products: unknown): IproyalCity | null {
	const list = Array.isArray(products)
		? products
		: products && typeof products === "object" && "data" in products
			? (products as { data: unknown }).data
			: [];
	if (!Array.isArray(list)) return null;
	const product = list.find(
		(item) =>
			item && typeof item === "object" && item.id === iproyalIspProductId,
	) as { locations?: unknown } | undefined;
	const locations = Array.isArray(product?.locations) ? product.locations : [];
	const us = locations.find(
		(item: { id?: unknown }) => item?.id === iproyalUsLocationId,
	) as { child_locations?: unknown } | undefined;
	const children = Array.isArray(us?.child_locations)
		? (us.child_locations as IproyalCity[])
		: [];
	const stock = children.filter(
		(city) =>
			city &&
			typeof city.id === "number" &&
			typeof city.name === "string" &&
			!city.out_of_stock,
	);
	for (const pattern of cityPreference) {
		const hit = stock.find((city) => pattern.test(city.name));
		if (hit) return hit;
	}
	return stock[0] ?? null;
}

const cityTimezones: Array<[RegExp, string]> = [
	[
		/New York|District Of Columbia|Boston|Massachusetts|New Jersey|Philadelphia|Pennsylvania|Virginia|Maryland|Delaware|Florida|Miami|Atlanta|Georgia|Carolina|Ohio|Michigan|Detroit|Connecticut|Maine|Vermont|New Hampshire|Rhode Island/,
		"America/New_York",
	],
	[
		/Seattle|Washington\)|San Francisco|San Jose|Los Angeles|El Segundo|California|Portland|Oregon|Nevada|Las Vegas/,
		"America/Los_Angeles",
	],
	[
		/Chicago|Illinois|Texas|Dallas|Houston|Austin|Minnesota|Missouri|Wisconsin/,
		"America/Chicago",
	],
	[/Denver|Colorado|Utah/, "America/Denver"],
	[/Phoenix|Arizona/, "America/Phoenix"],
];

/** City-name fallback when ip-api is unavailable. Always an IANA name. */
export function timezoneForCity(name: string | null | undefined) {
	for (const [pattern, tz] of cityTimezones)
		if (name && pattern.test(name)) return tz;
	return "America/New_York";
}

export function isIanaTimezone(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)
	)
		return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** "Springfield (Massachusetts)" → "Springfield, Massachusetts". */
export function displayCity(name: string | null | undefined) {
	if (!name) return null;
	const match = /^(.*?)\s*\((.+)\)$/.exec(name);
	return match ? `${match[1]}, ${match[2]}` : name;
}

// ---------- quality ----------

export type QualityInput = {
	trustScore: number | null;
	scamScore: number | null;
};

/** trust ≥ 80 and scamalytics ≤ 40; an unreadable score only warns. */
export function evaluateQuality(input: QualityInput) {
	const fails: string[] = [];
	const warns: string[] = [];
	if (input.trustScore === null) warns.push("信任分查不到");
	else if (input.trustScore < minTrustScore)
		fails.push(`信任分 ${input.trustScore}（要求 ≥${minTrustScore}）`);
	if (input.scamScore === null) warns.push("scamalytics 风险分查不到");
	else if (input.scamScore > maxScamScore)
		fails.push(
			`scamalytics 风险分 ${input.scamScore}（要求 ≤${maxScamScore}）`,
		);
	return { pass: fails.length === 0, fails, warns };
}

export function parseScamalyticsScore(html: string) {
	const match = /Fraud Score:\s*(\d{1,3})/.exec(html);
	return match ? Number(match[1]) : null;
}

// ---------- expiry reminders ----------

/** Customer reminders N days before expires_at (monthly and quarterly alike). */
export const reminderPoints = [7, 5, 3] as const;
export type ReminderPoint = (typeof reminderPoints)[number];
/** The owner also gets a Telegram at this point (support follows up on WeChat). */
export const ownerReminderPoint: ReminderPoint = 3;

/**
 * The reminder point due now: the nearest point already reached before expiry.
 * A subscription that enters the window late (e.g. 4 days left at activation)
 * gets only that nearest point, never a burst of the earlier ones.
 */
export function dueReminderPoint(
	expiresAt: number,
	now: number,
): ReminderPoint | null {
	if (expiresAt <= now) return null;
	let due: ReminderPoint | null = null;
	for (const point of reminderPoints)
		if (expiresAt - point * dayMs <= now) due = point;
	return due;
}

/** Whole days left, rounded up (6 days 23 hours → 7). */
export function daysLeft(expiresAt: number, now: number) {
	return Math.max(0, Math.ceil((expiresAt - now) / dayMs));
}

/** "2026-11-23 08:07" in Beijing time (UTC+8, no DST). */
export function beijingMinute(ms: number) {
	return new Date(ms + 8 * 3_600_000)
		.toISOString()
		.slice(0, 16)
		.replace("T", " ");
}

/** Renewals always use the regular price of the same duration (early-bird is first period only). */
export const renewalSkuIds = {
	monthly: "c3bab030-0c3c-4451-9c41-3cc32538e778",
	quarterly: "1e599d3a-3aa2-498e-a955-f4b04a4abdc4",
} as const;

export function renewalSkuForPlan(plan: string) {
	return plan === "quarterly" || plan === "eb_quarterly"
		? renewalSkuIds.quarterly
		: renewalSkuIds.monthly;
}

/** Product page with the regular-price SKU of the same duration preselected. */
export function renewalPath(plan: string) {
	return `/products/${claudeEnvProductId}?item=${renewalSkuForPlan(plan)}#purchase-options`;
}

/** Straight to checkout with one unit of `sku` (the product page's own "buy now" link). */
export function checkoutPath(sku: string) {
	return `/checkout?mode=buy-now&sellableItemId=${encodeURIComponent(sku)}&quantity=1`;
}

// ---------- traffic add-ons (2026-10-26) ----------

/**
 * 「Claude 专属环境 · 流量加购」: a separate, unlisted product (never on the
 * homepage, catalog or sitemap) sold only from the customer panel. Manual
 * fulfillment without stock; the control-center cron raises the quota and
 * completes the delivery. Production rows: ops/claude-env-traffic-skus.sql.
 */
export const claudeEnvTrafficProductId = "e07fd8fc-5f0f-416e-9d85-382c091256a2";

export const claudeEnvTrafficSkus: Record<
	string,
	{ gb: number; label: string }
> = {
	"c3675807-27e7-4442-a820-e4016b8c0e37": { gb: 100, label: "100GB" },
	"f1ea0f36-274a-414c-aa36-c6ebad153d3b": { gb: 500, label: "500GB" },
	"f69b64f7-36dd-49e2-a07f-9df5a63fb4d2": { gb: 1000, label: "1TB" },
};

export const claudeEnvTrafficSkuIds = Object.keys(claudeEnvTrafficSkus);

export const gbBytes = 1_000_000_000;
/** IPRoyal includes this much per IP per 30-day cycle; more is bought on demand. */
export const iproyalIncludedBytes = 100 * gbBytes;
/** Owner safety net: relay usage at which IPRoyal capacity should have been raised. */
export const upstreamAlertBytes = 85 * gbBytes;

/** Customer usage notices, in basis points of the period's entitlement. */
export const trafficNoticeThresholds = [7500, 9000, 9750] as const;
export type TrafficNoticeThreshold = (typeof trafficNoticeThresholds)[number];

/** Highest threshold `used` has reached of `entitled`; null below 75%. */
export function trafficLevel(
	used: number,
	entitled: number,
): TrafficNoticeThreshold | null {
	let level: TrafficNoticeThreshold | null = null;
	for (const bps of trafficNoticeThresholds)
		if (entitled > 0 && used * 10_000 >= entitled * bps) level = bps;
	return level;
}

/** "150 GB", "52.3 GB": whole or one-decimal GB for customer copy. */
export function formatGb(bytes: number) {
	return `${Number((Math.max(0, bytes) / gbBytes).toFixed(1))} GB`;
}

// ---------- dates and traffic ----------

/** Renewal: expires = max(now, expires) + days. */
export function extendExpiry(
	expiresAt: number | null,
	now: number,
	days: number,
) {
	return Math.max(now, expiresAt ?? now) + days * dayMs;
}

/** Start of the 30-day traffic period containing `now`, counted from activation. */
export function trafficPeriodStart(activatedAt: number, now: number) {
	if (now <= activatedAt) return activatedAt;
	return (
		activatedAt +
		Math.floor((now - activatedAt) / trafficPeriodMs) * trafficPeriodMs
	);
}

export function maskEmail(email: string) {
	const [local = "", domain = ""] = email.split("@");
	const head = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
	return `${head}${"*".repeat(Math.max(1, local.length - head.length))}@${domain}`;
}

export function formatBytes(bytes: number) {
	if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

export function utcMonth(now: number) {
	return new Date(now).toISOString().slice(0, 7);
}

// ---------- customer commands ----------

export const scriptOrigin = "https://laoshirenvip.com";

export function customerCommands(code: string) {
	return {
		mac: `curl -fsSL ${scriptOrigin}/claude-env.sh -o /tmp/claude-env.sh && bash /tmp/claude-env.sh '${code}'`,
		windows: `irm ${scriptOrigin}/claude-env.ps1 -OutFile $env:TEMP\\claude-env.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\\claude-env.ps1 -Code '${code}'`,
		ipCheck: `${scriptOrigin}/ip-check`,
	};
}

// ---------- review additions (2026-10-24) ----------

/** A posting/extending claim older than this is "结果不明" (IPRoyal calls time out after 20 s). */
export const staleClaimMs = 5 * 60_000;
/** A relay port is never handed to another customer within this window. */
export const portReuseMs = 30 * dayMs;

const ipv4Pattern =
	/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export function isIpv4(value: unknown): value is string {
	return typeof value === "string" && ipv4Pattern.test(value);
}

const canonicalZones: Array<[RegExp, string]> = [
	[
		/^(America\/(Detroit|Fort_Wayne|Indianapolis|Louisville|Indiana\/(Indianapolis|Marengo|Petersburg|Vevay|Vincennes|Winamac)|Kentucky\/(Louisville|Monticello))|US\/(Eastern|Michigan|East-Indiana)|EST5EDT)$/,
		"America/New_York",
	],
	[
		/^(America\/(Menominee|Knox_IN|Indiana\/(Knox|Tell_City)|North_Dakota\/(Center|New_Salem|Beulah))|US\/(Central|Indiana-Starke)|CST6CDT)$/,
		"America/Chicago",
	],
	[
		/^(America\/(Boise|Shiprock)|US\/Mountain|MST7MDT|Navajo)$/,
		"America/Denver",
	],
	[/^(US\/Arizona|MST)$/, "America/Phoenix"],
	[/^(US\/Pacific|PST8PDT)$/, "America/Los_Angeles"],
	[
		/^(America\/(Juneau|Sitka|Metlakatla|Nome|Yakutat)|US\/Alaska)$/,
		"America/Anchorage",
	],
	[/^(US\/Hawaii|HST)$/, "Pacific/Honolulu"],
];

/**
 * Folds US zone aliases onto the 7 canonical names the Windows script maps
 * (America/New_York, Chicago, Denver, Phoenix, Los_Angeles, Anchorage,
 * Pacific/Honolulu). Other IANA names are kept as they are.
 */
export function canonicalTimezone(tz: string) {
	for (const [pattern, canonical] of canonicalZones)
		if (pattern.test(tz)) return canonical;
	return tz;
}

/**
 * IPRoyal `expire_date` ("2024-04-20 10:25:12"). The docs give no zone; read
 * as UTC (unverified — compare with the IPRoyal dashboard on the first order).
 */
export function parseIproyalDate(value: unknown) {
	if (typeof value !== "string") return null;
	const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(
		value.trim(),
	);
	if (!match) return null;
	const ms = Date.parse(`${match[1]}T${match[2]}Z`);
	return Number.isFinite(ms) ? ms : null;
}
